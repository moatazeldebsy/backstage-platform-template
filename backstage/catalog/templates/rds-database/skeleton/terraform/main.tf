terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.5"
    }
  }

  # Uncomment and configure for remote state
  # backend "s3" {
  #   bucket         = "idp-mvp-terraform-state-<ACCOUNT_ID>"
  #   key            = "infra/managed-postgres/${{ values.instanceName }}/terraform.tfstate"
  #   region         = "${{ values.awsRegion }}"
  #   dynamodb_table = "idp-mvp-terraform-locks"
  #   encrypt        = true
  # }
}

provider "aws" {
  region = var.aws_region
}

# ---------------------------------------------------------------------------
# Random password (written to Secrets Manager)
# ---------------------------------------------------------------------------
resource "random_password" "db" {
  length           = 32
  special          = true
  override_special = "!#$%&*()-_=+[]{}<>:?"
}

# ---------------------------------------------------------------------------
# Parameter group
# ---------------------------------------------------------------------------
resource "aws_db_parameter_group" "this" {
  name        = var.instance_name
  family      = "postgres${var.postgres_version}"
  description = "Parameter group for ${var.instance_name}"

  parameter {
    name  = "log_connections"
    value = "1"
  }

  parameter {
    name  = "log_disconnections"
    value = "1"
  }

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# RDS instance
# ---------------------------------------------------------------------------
resource "aws_db_instance" "this" {
  identifier        = var.instance_name
  engine            = "postgres"
  engine_version    = var.postgres_version
  instance_class    = var.instance_class
  allocated_storage = var.storage_gb
  storage_type      = "gp3"
  storage_encrypted = true

  db_name  = var.db_name
  username = var.db_username
  password = random_password.db.result

  parameter_group_name   = aws_db_parameter_group.this.name
  multi_az               = var.multi_az
  backup_retention_period = var.backup_retention_days
  backup_window          = "03:00-04:00"
  maintenance_window     = "Mon:04:00-Mon:05:00"

  deletion_protection = var.multi_az # protect production instances
  skip_final_snapshot = !var.multi_az

  iam_database_authentication_enabled = var.enable_iam_auth

  tags = merge(local.common_tags, {
    service = var.owner_service
  })
}

# ---------------------------------------------------------------------------
# Secrets Manager — store credentials
# ---------------------------------------------------------------------------
resource "aws_secretsmanager_secret" "db" {
  name        = "idp-mvp/${var.owner_service}/db-credentials"
  description = "RDS credentials for ${var.instance_name} (managed by IDP)"

  tags = local.common_tags
}

resource "aws_secretsmanager_secret_version" "db" {
  secret_id = aws_secretsmanager_secret.db.id
  secret_string = jsonencode({
    username = aws_db_instance.this.username
    password = random_password.db.result
    host     = aws_db_instance.this.address
    port     = tostring(aws_db_instance.this.port)
    dbname   = var.db_name
  })
}

# ---------------------------------------------------------------------------
# IAM role for RDS IAM authentication (optional)
# ---------------------------------------------------------------------------
data "aws_iam_policy_document" "rds_iam_auth" {
  count = var.enable_iam_auth ? 1 : 0

  statement {
    actions   = ["rds-db:connect"]
    resources = ["arn:aws:rds-db:${var.aws_region}:${data.aws_caller_identity.current.account_id}:dbuser:${aws_db_instance.this.resource_id}/${var.db_username}"]
  }
}

resource "aws_iam_policy" "rds_iam_auth" {
  count       = var.enable_iam_auth ? 1 : 0
  name        = "${var.instance_name}-iam-auth"
  description = "Allows IAM authentication to ${var.instance_name}"
  policy      = data.aws_iam_policy_document.rds_iam_auth[0].json

  tags = local.common_tags
}

data "aws_caller_identity" "current" {}

# ---------------------------------------------------------------------------
# Locals
# ---------------------------------------------------------------------------
locals {
  common_tags = {
    "managed-by"   = "idp-backstage"
    "instance-name" = var.instance_name
    "owner"        = var.owner_service
  }
}
