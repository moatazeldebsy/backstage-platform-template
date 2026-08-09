# ── Cost optimizer: overnight node scale-down + RDS stop ─────────────────────
#
# docs/DEPLOYMENT_GUIDE.md has documented this feature for a while, and
# variables.tf declared enable_cost_optimizer plus the two cron variables — but
# no resource ever referenced them, and the two handlers under lambda/ were
# never deployed. Setting the flag did nothing at all; the cluster ran 24/7
# regardless. This file is the missing half, and matches the two-Lambda table
# in that doc: an EKS node scaler and an RDS scheduler on a shared schedule.
#
# At the default 8 PM → 7 AM window that is ~11h/day off, roughly 45% of EC2 +
# RDS spend.
#
# Caveats worth knowing before enabling:
#   - Scaling nodes to zero evicts every pod. Stateful workloads (Prometheus,
#     MLflow, Loki) resume from their PVCs, but in-flight ArgoCD syncs and any
#     running Argo Workflow are lost.
#   - AWS force-starts an RDS instance left stopped for 7 consecutive days. Both
#     handlers treat an already-in-state instance as a no-op, not an error.
#   - The EKS control plane (~$73/mo) and the NAT gateway bill regardless — this
#     only touches the node group and the database.

locals {
  # module.eks exposes node_group_id as "<cluster>:<nodegroup>"; the EKS API
  # wants just the node group name.
  platform_node_group_name = var.enable_cost_optimizer ? split(":", module.eks.eks_managed_node_groups["platform"].node_group_id)[1] : ""

  cost_optimizer_schedules = var.enable_cost_optimizer ? {
    scale_down = var.cost_optimizer_scale_down_cron
    scale_up   = var.cost_optimizer_scale_up_cron
  } : {}

  # The two handlers use their own vocabulary for the same two directions.
  rds_action = {
    scale_down = "stop"
    scale_up   = "start"
  }
}

# source_file, not source_dir: neither handler has dependencies beyond boto3
# (present in the Lambda runtime), and these directories accumulate macOS SMB
# lock files (.!12345!handler.zip) that source_dir would silently package.
data "archive_file" "eks_node_scaler" {
  count       = var.enable_cost_optimizer ? 1 : 0
  type        = "zip"
  source_file = "${path.module}/lambda/eks-node-scaler/handler.py"
  output_path = "${path.module}/lambda/eks-node-scaler.zip"
}

data "archive_file" "rds_scheduler" {
  count       = var.enable_cost_optimizer ? 1 : 0
  type        = "zip"
  source_file = "${path.module}/lambda/rds-scheduler/handler.py"
  output_path = "${path.module}/lambda/rds-scheduler.zip"
}

# ── IAM ───────────────────────────────────────────────────────────────────────

resource "aws_iam_role" "cost_optimizer" {
  count = var.enable_cost_optimizer ? 1 : 0
  name  = "${var.cluster_name}-cost-optimizer"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = {
    Project    = var.cluster_name
    ManagedBy  = "terraform"
    CostCenter = "platform"
  }
}

resource "aws_iam_role_policy_attachment" "cost_optimizer_basic" {
  count      = var.enable_cost_optimizer ? 1 : 0
  role       = aws_iam_role.cost_optimizer[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# Scoped to this cluster's node group and this cluster's database — not eks:* /
# rds:* account-wide.
resource "aws_iam_role_policy" "cost_optimizer" {
  count = var.enable_cost_optimizer ? 1 : 0
  name  = "${var.cluster_name}-cost-optimizer"
  role  = aws_iam_role.cost_optimizer[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "eks:UpdateNodegroupConfig",
          "eks:DescribeNodegroup",
        ]
        Resource = "arn:aws:eks:${var.aws_region}:${data.aws_caller_identity.current.account_id}:nodegroup/${var.cluster_name}/${local.platform_node_group_name}/*"
      },
      {
        Effect = "Allow"
        Action = [
          "rds:StopDBInstance",
          "rds:StartDBInstance",
          "rds:DescribeDBInstances",
        ]
        Resource = aws_db_instance.backstage.arn
      },
    ]
  })
}

# ── Lambdas ───────────────────────────────────────────────────────────────────

resource "aws_lambda_function" "eks_node_scaler" {
  count            = var.enable_cost_optimizer ? 1 : 0
  filename         = data.archive_file.eks_node_scaler[0].output_path
  function_name    = "${var.cluster_name}-eks-node-scaler"
  role             = aws_iam_role.cost_optimizer[0].arn
  handler          = "handler.lambda_handler"
  runtime          = "python3.12"
  timeout          = 60
  source_code_hash = data.archive_file.eks_node_scaler[0].output_base64sha256

  environment {
    variables = {
      CLUSTER_NAME    = var.cluster_name
      NODE_GROUP_NAME = local.platform_node_group_name
      # Restore to the shape Terraform manages, so a scale_up does not leave
      # the node group fighting the next `terraform apply`.
      MIN_SIZE     = tostring(var.node_group_min_size)
      DESIRED_SIZE = tostring(var.node_group_desired_size)
      MAX_SIZE     = tostring(var.node_group_max_size)
    }
  }

  tags = {
    Project    = var.cluster_name
    ManagedBy  = "terraform"
    CostCenter = "platform"
  }
}

resource "aws_lambda_function" "rds_scheduler" {
  count            = var.enable_cost_optimizer ? 1 : 0
  filename         = data.archive_file.rds_scheduler[0].output_path
  function_name    = "${var.cluster_name}-rds-scheduler"
  role             = aws_iam_role.cost_optimizer[0].arn
  handler          = "handler.lambda_handler"
  runtime          = "python3.12"
  timeout          = 60
  source_code_hash = data.archive_file.rds_scheduler[0].output_base64sha256

  environment {
    variables = {
      DB_INSTANCE_ID = aws_db_instance.backstage.identifier
    }
  }

  tags = {
    Project    = var.cluster_name
    ManagedBy  = "terraform"
    CostCenter = "platform"
  }
}

# ── Schedules ─────────────────────────────────────────────────────────────────
# One rule per direction, each fanning out to both Lambdas. The direction
# travels in the target input, so each function is deployed once rather than
# once per direction.

resource "aws_cloudwatch_event_rule" "cost_optimizer" {
  for_each = local.cost_optimizer_schedules

  name                = "${var.cluster_name}-cost-optimizer-${replace(each.key, "_", "-")}"
  description         = "Cost optimizer: ${each.key} the ${var.cluster_name} node group and RDS instance"
  schedule_expression = each.value

  tags = {
    Project   = var.cluster_name
    ManagedBy = "terraform"
  }
}

resource "aws_cloudwatch_event_target" "eks_node_scaler" {
  for_each = aws_cloudwatch_event_rule.cost_optimizer

  rule      = each.value.name
  target_id = "eks-node-scaler"
  arn       = aws_lambda_function.eks_node_scaler[0].arn
  input     = jsonencode({ action = each.key })
}

resource "aws_cloudwatch_event_target" "rds_scheduler" {
  for_each = aws_cloudwatch_event_rule.cost_optimizer

  rule      = each.value.name
  target_id = "rds-scheduler"
  arn       = aws_lambda_function.rds_scheduler[0].arn
  input     = jsonencode({ action = local.rds_action[each.key] })
}

resource "aws_lambda_permission" "eks_node_scaler" {
  for_each = aws_cloudwatch_event_rule.cost_optimizer

  statement_id  = "AllowEventBridge-${each.key}"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.eks_node_scaler[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = each.value.arn
}

resource "aws_lambda_permission" "rds_scheduler" {
  for_each = aws_cloudwatch_event_rule.cost_optimizer

  statement_id  = "AllowEventBridge-${each.key}"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.rds_scheduler[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = each.value.arn
}
