# IRSA role for the failover-runner ServiceAccount used by the Argo Workflows failover runbook.
# Grants minimum permissions needed by each step in failover-runbook.yaml:
#   - rds:FailoverGlobalCluster + DescribeDBClusters
#   - globalaccelerator:UpdateEndpointGroup + ListEndpointGroups + ListListeners
#   - secretsmanager:GetSecretValue (for Slack webhook)
#
# The trust policy is scoped to the Argo Workflows pod SA in the argo namespace.

data "aws_iam_policy_document" "failover_runner_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [var.oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${replace(var.oidc_provider_arn, "arn:aws:iam::${data.aws_caller_identity.current.account_id}:oidc-provider/", "")}:sub"
      values   = ["system:serviceaccount:argo:failover-runner"]
    }
  }
}

data "aws_iam_policy_document" "failover_runner" {
  # Aurora Global Database failover
  statement {
    sid    = "AuroraFailover"
    effect = "Allow"
    actions = [
      "rds:FailoverGlobalCluster",
      "rds:DescribeGlobalClusters",
      "rds:DescribeDBClusters",
    ]
    resources = ["*"]
  }

  # Global Accelerator traffic shift
  statement {
    sid    = "GlobalAcceleratorShift"
    effect = "Allow"
    actions = [
      "globalaccelerator:ListAccelerators",
      "globalaccelerator:ListListeners",
      "globalaccelerator:ListEndpointGroups",
      "globalaccelerator:UpdateEndpointGroup",
    ]
    resources = ["*"]
  }

  # Read Slack webhook from Secrets Manager
  statement {
    sid    = "ReadSlackWebhook"
    effect = "Allow"
    actions = [
      "secretsmanager:GetSecretValue",
    ]
    resources = [
      "arn:aws:secretsmanager:${var.primary_region}:${data.aws_caller_identity.current.account_id}:secret:idp-mvp/slack-webhook*",
    ]
  }

  # EKS DescribeCluster — needed for kubectl auth in the runbook steps
  statement {
    sid    = "EKSDescribe"
    effect = "Allow"
    actions = [
      "eks:DescribeCluster",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role" "failover_runner" {
  name               = "idp-mvp-failover-runner"
  assume_role_policy = data.aws_iam_policy_document.failover_runner_assume.json

  tags = { Name = "idp-mvp-failover-runner" }
}

resource "aws_iam_role_policy" "failover_runner" {
  name   = "idp-mvp-failover-runner-policy"
  role   = aws_iam_role.failover_runner.id
  policy = data.aws_iam_policy_document.failover_runner.json
}

output "failover_runner_role_arn" {
  description = "IRSA role ARN for the failover-runner ServiceAccount — annotate the SA with this ARN"
  value       = aws_iam_role.failover_runner.arn
}
