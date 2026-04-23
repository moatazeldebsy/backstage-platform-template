# Cost Optimizer — scheduled scale-down/up for EKS nodes and RDS
#
# Saves ~$40–60/month by zeroing EKS nodes and stopping RDS overnight.
#
# Default schedule (UTC):
#   Scale down: 8 pm UTC daily   → cron(0 20 * * ? *)
#   Scale up:   7 am UTC daily   → cron(0 7  * * ? *)
#
# Enable in terraform.tfvars:
#   enable_cost_optimizer = true

# ── Guard: only create resources when the feature is enabled ─────────────────
locals {
  optimizer_enabled = var.enable_cost_optimizer
}

# ── Shared IAM role for both scheduler Lambdas ───────────────────────────────
resource "aws_iam_role" "cost_optimizer" {
  count = local.optimizer_enabled ? 1 : 0
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
    Project     = var.cluster_name
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

resource "aws_iam_role_policy_attachment" "cost_optimizer_basic" {
  count      = local.optimizer_enabled ? 1 : 0
  role       = aws_iam_role.cost_optimizer[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "cost_optimizer_permissions" {
  count = local.optimizer_enabled ? 1 : 0
  name  = "eks-rds-scheduler"
  role  = aws_iam_role.cost_optimizer[0].name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "EKSNodeGroupScaling"
        Effect = "Allow"
        Action = [
          "eks:UpdateNodegroupConfig",
          "eks:DescribeNodegroup",
        ]
        Resource = "*"
      },
      {
        Sid    = "RDSStartStop"
        Effect = "Allow"
        Action = [
          "rds:StopDBInstance",
          "rds:StartDBInstance",
          "rds:DescribeDBInstances",
        ]
        Resource = "arn:aws:rds:${var.aws_region}:${data.aws_caller_identity.current.account_id}:db:${var.cluster_name}-backstage"
      }
    ]
  })
}

# ── EKS Node Scaler Lambda ───────────────────────────────────────────────────
data "archive_file" "eks_node_scaler" {
  count       = local.optimizer_enabled ? 1 : 0
  type        = "zip"
  source_file = "${path.module}/lambda/eks-node-scaler/handler.py"
  output_path = "${path.module}/lambda/eks-node-scaler/handler.zip"
}

resource "aws_cloudwatch_log_group" "eks_node_scaler" {
  count             = local.optimizer_enabled ? 1 : 0
  name              = "/aws/lambda/${var.cluster_name}-eks-node-scaler"
  retention_in_days = 14

  tags = {
    Project     = var.cluster_name
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

resource "aws_lambda_function" "eks_scale_down" {
  count            = local.optimizer_enabled ? 1 : 0
  function_name    = "${var.cluster_name}-eks-scale-down"
  filename         = data.archive_file.eks_node_scaler[0].output_path
  source_code_hash = data.archive_file.eks_node_scaler[0].output_base64sha256
  role             = aws_iam_role.cost_optimizer[0].arn
  handler          = "handler.lambda_handler"
  runtime          = "python3.12"
  timeout          = 30

  environment {
    variables = {
      CLUSTER_NAME    = var.cluster_name
      NODE_GROUP_NAME = "platform"
      ACTION          = "scale_down"
      MAX_SIZE        = tostring(var.node_group_max_size)
    }
  }

  depends_on = [aws_cloudwatch_log_group.eks_node_scaler]

  tags = {
    Project     = var.cluster_name
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

resource "aws_lambda_function" "eks_scale_up" {
  count            = local.optimizer_enabled ? 1 : 0
  function_name    = "${var.cluster_name}-eks-scale-up"
  filename         = data.archive_file.eks_node_scaler[0].output_path
  source_code_hash = data.archive_file.eks_node_scaler[0].output_base64sha256
  role             = aws_iam_role.cost_optimizer[0].arn
  handler          = "handler.lambda_handler"
  runtime          = "python3.12"
  timeout          = 60

  environment {
    variables = {
      CLUSTER_NAME    = var.cluster_name
      NODE_GROUP_NAME = "platform"
      ACTION          = "scale_up"
      MIN_SIZE        = tostring(var.node_group_min_size)
      DESIRED_SIZE    = tostring(var.node_group_desired_size)
      MAX_SIZE        = tostring(var.node_group_max_size)
    }
  }

  depends_on = [aws_cloudwatch_log_group.eks_node_scaler]

  tags = {
    Project     = var.cluster_name
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

# ── RDS Scheduler Lambda ─────────────────────────────────────────────────────
data "archive_file" "rds_scheduler" {
  count       = local.optimizer_enabled ? 1 : 0
  type        = "zip"
  source_file = "${path.module}/lambda/rds-scheduler/handler.py"
  output_path = "${path.module}/lambda/rds-scheduler/handler.zip"
}

resource "aws_cloudwatch_log_group" "rds_scheduler" {
  count             = local.optimizer_enabled ? 1 : 0
  name              = "/aws/lambda/${var.cluster_name}-rds-scheduler"
  retention_in_days = 14

  tags = {
    Project     = var.cluster_name
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

resource "aws_lambda_function" "rds_stop" {
  count            = local.optimizer_enabled ? 1 : 0
  function_name    = "${var.cluster_name}-rds-stop"
  filename         = data.archive_file.rds_scheduler[0].output_path
  source_code_hash = data.archive_file.rds_scheduler[0].output_base64sha256
  role             = aws_iam_role.cost_optimizer[0].arn
  handler          = "handler.lambda_handler"
  runtime          = "python3.12"
  timeout          = 30

  environment {
    variables = {
      DB_INSTANCE_ID = "${var.cluster_name}-backstage"
      ACTION         = "stop"
    }
  }

  depends_on = [aws_cloudwatch_log_group.rds_scheduler]

  tags = {
    Project     = var.cluster_name
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

resource "aws_lambda_function" "rds_start" {
  count            = local.optimizer_enabled ? 1 : 0
  function_name    = "${var.cluster_name}-rds-start"
  filename         = data.archive_file.rds_scheduler[0].output_path
  source_code_hash = data.archive_file.rds_scheduler[0].output_base64sha256
  role             = aws_iam_role.cost_optimizer[0].arn
  handler          = "handler.lambda_handler"
  runtime          = "python3.12"
  timeout          = 30

  environment {
    variables = {
      DB_INSTANCE_ID = "${var.cluster_name}-backstage"
      ACTION         = "start"
    }
  }

  depends_on = [aws_cloudwatch_log_group.rds_scheduler]

  tags = {
    Project     = var.cluster_name
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

# ── EventBridge Schedules ────────────────────────────────────────────────────

# --- Scale down (8 pm UTC daily) ---
resource "aws_cloudwatch_event_rule" "scale_down" {
  count               = local.optimizer_enabled ? 1 : 0
  name                = "${var.cluster_name}-scale-down"
  description         = "Scale EKS nodes to 0 and stop RDS at night"
  schedule_expression = var.cost_optimizer_scale_down_cron

  tags = {
    Project     = var.cluster_name
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

resource "aws_cloudwatch_event_target" "eks_scale_down" {
  count     = local.optimizer_enabled ? 1 : 0
  rule      = aws_cloudwatch_event_rule.scale_down[0].name
  target_id = "eks-scale-down"
  arn       = aws_lambda_function.eks_scale_down[0].arn
}

resource "aws_cloudwatch_event_target" "rds_stop" {
  count     = local.optimizer_enabled ? 1 : 0
  rule      = aws_cloudwatch_event_rule.scale_down[0].name
  target_id = "rds-stop"
  arn       = aws_lambda_function.rds_stop[0].arn
}

resource "aws_lambda_permission" "allow_eb_eks_scale_down" {
  count         = local.optimizer_enabled ? 1 : 0
  statement_id  = "AllowEBTrigger"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.eks_scale_down[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.scale_down[0].arn
}

resource "aws_lambda_permission" "allow_eb_rds_stop" {
  count         = local.optimizer_enabled ? 1 : 0
  statement_id  = "AllowEBTrigger"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.rds_stop[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.scale_down[0].arn
}

# --- Scale up (7 am UTC daily) ---
resource "aws_cloudwatch_event_rule" "scale_up" {
  count               = local.optimizer_enabled ? 1 : 0
  name                = "${var.cluster_name}-scale-up"
  description         = "Scale EKS nodes back up and start RDS in the morning"
  schedule_expression = var.cost_optimizer_scale_up_cron

  tags = {
    Project     = var.cluster_name
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

resource "aws_cloudwatch_event_target" "eks_scale_up" {
  count     = local.optimizer_enabled ? 1 : 0
  rule      = aws_cloudwatch_event_rule.scale_up[0].name
  target_id = "eks-scale-up"
  arn       = aws_lambda_function.eks_scale_up[0].arn
}

resource "aws_cloudwatch_event_target" "rds_start" {
  count     = local.optimizer_enabled ? 1 : 0
  rule      = aws_cloudwatch_event_rule.scale_up[0].name
  target_id = "rds-start"
  arn       = aws_lambda_function.rds_start[0].arn
}

resource "aws_lambda_permission" "allow_eb_eks_scale_up" {
  count         = local.optimizer_enabled ? 1 : 0
  statement_id  = "AllowEBTrigger"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.eks_scale_up[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.scale_up[0].arn
}

resource "aws_lambda_permission" "allow_eb_rds_start" {
  count         = local.optimizer_enabled ? 1 : 0
  statement_id  = "AllowEBTrigger"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.rds_start[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.scale_up[0].arn
}

# ── Outputs ───────────────────────────────────────────────────────────────────
output "cost_optimizer_enabled" {
  description = "Whether the overnight cost optimizer is active"
  value       = local.optimizer_enabled
}

output "cost_optimizer_schedule" {
  description = "Scale-down / scale-up cron expressions (UTC)"
  value = local.optimizer_enabled ? {
    scale_down = var.cost_optimizer_scale_down_cron
    scale_up   = var.cost_optimizer_scale_up_cron
  } : null
}
