data "aws_caller_identity" "current" {}

# EBS CSI Driver role
resource "aws_iam_role" "ebs_csi_driver" {
  name = "${var.cluster_name}-ebs-csi-driver"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Federated = module.eks.oidc_provider_arn
      }
      Action = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "${module.eks.oidc_provider}:aud" = "sts.amazonaws.com"
          "${module.eks.oidc_provider}:sub" = "system:serviceaccount:kube-system:ebs-csi-controller-sa"
        }
      }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ebs_csi_driver" {
  role       = aws_iam_role.ebs_csi_driver.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy"
}

# GitHub Actions OIDC provider for keyless auth
resource "aws_iam_openid_connect_provider" "github_actions" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

# IAM role for GitHub Actions CI/CD
resource "aws_iam_role" "github_actions" {
  name = "${var.cluster_name}-github-actions"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Federated = aws_iam_openid_connect_provider.github_actions.arn
      }
      Action = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringLike = {
          "token.actions.githubusercontent.com:sub" = "repo:${var.github_org}/*:*"
        }
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        }
      }
    }]
  })
}

# Terraform CI/CD requires broad read access for plan refreshes (IAM, EC2, EKS, S3, ECR, RDS, etc.)
# PowerUserAccess + IAMFullAccess is the standard pattern for roles that run terraform apply
# on complex infrastructure. The role is already locked down by the OIDC trust policy to
# only be assumable via GitHub Actions on this specific repository.
resource "aws_iam_role_policy_attachment" "github_actions_power_user" {
  role       = aws_iam_role.github_actions.name
  policy_arn = "arn:aws:iam::aws:policy/PowerUserAccess"
}

resource "aws_iam_role_policy_attachment" "github_actions_iam_full" {
  role       = aws_iam_role.github_actions.name
  policy_arn = "arn:aws:iam::aws:policy/IAMFullAccess"
}

# Explicit inline policy for Terraform remote state (belt-and-suspenders, S3/DynamoDB
# access for the state bucket is already covered by PowerUserAccess but listed here
# for clarity and auditability)
resource "aws_iam_role_policy" "github_actions_tfstate" {
  name = "terraform-state"
  role = aws_iam_role.github_actions.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "TerraformStateS3"
        Effect = "Allow"
        Action = [
          "s3:ListBucket",
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject"
        ]
        Resource = [
          "arn:aws:s3:::${var.cluster_name}-terraform-state-${data.aws_caller_identity.current.account_id}",
          "arn:aws:s3:::${var.cluster_name}-terraform-state-${data.aws_caller_identity.current.account_id}/*"
        ]
      },
      {
        Sid    = "TerraformStateDynamoDB"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:DeleteItem",
          "dynamodb:DescribeTable"
        ]
        Resource = "arn:aws:dynamodb:${var.aws_region}:${data.aws_caller_identity.current.account_id}:table/${var.cluster_name}-terraform-locks"
      }
    ]
  })
}

# Backstage IRSA — needs read access to K8s and AWS resources for catalog,
# plus Secrets Manager and S3 for TechDocs. Also used by ESO SecretStore.
module "backstage_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.30"

  role_name = "${var.cluster_name}-backstage"

  oidc_providers = {
    main = {
      provider_arn = module.eks.oidc_provider_arn
      # Includes both backstage SA and ESO SA so both can assume this role
      namespace_service_accounts = [
        "backstage:backstage",
        "external-secrets:external-secrets-sa"
      ]
    }
  }
}

resource "aws_iam_role_policy" "backstage" {
  name = "backstage-catalog"
  role = module.backstage_irsa.iam_role_name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "eks:ListClusters",
          "eks:DescribeCluster",
          "ecs:ListClusters",
          "ecs:ListServices"
        ]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret"
        ]
        # Backstage secret + any secret the ClusterSecretStore needs to sync
        Resource = [
          aws_secretsmanager_secret.backstage.arn,
          "arn:aws:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:idp-mvp/dora-exporter*"
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:ListBucket"
        ]
        Resource = [
          aws_s3_bucket.techdocs.arn,
          "${aws_s3_bucket.techdocs.arn}/*"
        ]
      },
      # FinOps: allow Backstage Cost Insights plugin to read cost data
      {
        Effect = "Allow"
        Action = [
          "ce:GetCostAndUsage",
          "ce:GetCostForecast",
          "ce:GetAnomalyMonitors",
          "ce:GetAnomalySubscriptions",
          "budgets:ViewBudget",
          "budgets:DescribeBudgets"
        ]
        Resource = "*"
      }
    ]
  })
}

# DB-init Job IRSA — allows the one-time Job SA to read the RDS master credentials
# from Secrets Manager so it can CREATE DATABASE + USER.
module "db_init_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.30"

  role_name = "${var.cluster_name}-db-init"

  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["services:db-init-sa"]
    }
  }
}

resource "aws_iam_role_policy" "db_init" {
  name = "db-init-secrets-read"
  role = module.db_init_irsa.iam_role_name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret"
        ]
        # Allow reading the Backstage secret (contains RDS master creds) and
        # all per-service db secrets so ESO can sync them after creation.
        Resource = [
          aws_secretsmanager_secret.backstage.arn,
          "arn:aws:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:idp-mvp/services/*"
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:CreateSecret",
          "secretsmanager:PutSecretValue",
          "secretsmanager:TagResource"
        ]
        Resource = "arn:aws:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:idp-mvp/services/*"
      }
    ]
  })
}

# DORA Exporter IRSA — allows the CronJob SA to publish to CloudWatch IDP/DORA namespace
module "dora_exporter_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.30"

  role_name = "${var.cluster_name}-dora-exporter"

  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["monitoring:dora-exporter-sa"]
    }
  }
}

resource "aws_iam_role_policy" "dora_exporter" {
  name = "dora-cloudwatch-putmetrics"
  role = module.dora_exporter_irsa.iam_role_name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["cloudwatch:PutMetricData"]
        Resource = "*"
        Condition = {
          StringEquals = {
            "cloudwatch:namespace" = "IDP/DORA"
          }
        }
      }
    ]
  })
}

output "dora_exporter_role_arn" {
  description = "IAM role ARN for the DORA exporter CronJob ServiceAccount (IRSA)"
  value       = module.dora_exporter_irsa.iam_role_arn
}

# Grafana IRSA — allows Grafana to query CloudWatch for dashboards
module "grafana_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.30"

  role_name = "${var.cluster_name}-grafana"

  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["monitoring:grafana"]
    }
  }

  role_policy_arns = {
    cloudwatch_read = "arn:aws:iam::aws:policy/CloudWatchReadOnlyAccess"
  }
}

output "grafana_role_arn" {
  description = "IAM role ARN for Grafana ServiceAccount (IRSA) — CloudWatch read access"
  value       = module.grafana_irsa.iam_role_arn
}

output "db_init_role_arn" {
  description = "IAM role ARN for the DB-init Job ServiceAccount (IRSA)"
  value       = module.db_init_irsa.iam_role_arn
}

output "github_actions_role_arn" {
  description = "IAM role ARN for GitHub Actions"
  value       = aws_iam_role.github_actions.arn
}

output "backstage_role_arn" {
  description = "IAM role ARN for Backstage"
  value       = module.backstage_irsa.iam_role_arn
}

# ── AI/ML IRSA roles ───────────────────────────────────────────────────────────────────

# MLflow IRSA — allows MLflow to read/write experiment artifacts to S3
module "mlflow_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.30"

  role_name = "${var.cluster_name}-mlflow"

  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["ml-platform:mlflow"]
    }
  }
}

resource "aws_iam_role_policy" "mlflow" {
  name = "mlflow-s3-artifacts"
  role = module.mlflow_irsa.iam_role_name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:ListBucket"
        ]
        Resource = [
          aws_s3_bucket.mlflow_artifacts.arn,
          "${aws_s3_bucket.mlflow_artifacts.arn}/*"
        ]
      }
    ]
  })
}

output "mlflow_role_arn" {
  description = "IAM role ARN for the MLflow ServiceAccount (IRSA) — S3 artifact access"
  value       = module.mlflow_irsa.iam_role_arn
}

# KAgent ESO IRSA — allows External Secrets Operator in the kagent namespace to
# read the Anthropic API key from Secrets Manager (idp-mvp/kagent).
module "kagent_eso_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.30"

  role_name = "${var.cluster_name}-kagent-eso"

  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["kagent:kagent-eso-sa"]
    }
  }
}

resource "aws_iam_role_policy" "kagent_eso" {
  name = "kagent-eso-secrets-read"
  role = module.kagent_eso_irsa.iam_role_name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret"
        ]
        Resource = aws_secretsmanager_secret.kagent.arn
      }
    ]
  })
}

output "kagent_eso_role_arn" {
  description = "IAM role ARN for the KAgent ESO ServiceAccount (IRSA) — reads idp-mvp/kagent from Secrets Manager"
  value       = module.kagent_eso_irsa.iam_role_arn
}
