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
  #   key            = "infra/s3-buckets/${{ values.bucketName }}/terraform.tfstate"
  #   region         = "us-east-1"
  #   dynamodb_table = "idp-mvp-terraform-locks"
  #   encrypt        = true
  # }
}

provider "aws" {
  region = var.aws_region
}

data "aws_caller_identity" "current" {}

# ---------------------------------------------------------------------------
# KMS key (only when encryption = aws-kms)
# ---------------------------------------------------------------------------
resource "aws_kms_key" "this" {
  count                   = var.encryption == "aws-kms" ? 1 : 0
  description             = "KMS key for S3 bucket ${var.bucket_name}"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  tags = local.common_tags
}

resource "aws_kms_alias" "this" {
  count         = var.encryption == "aws-kms" ? 1 : 0
  name          = "alias/${var.bucket_name}-s3"
  target_key_id = aws_kms_key.this[0].key_id
}

# ---------------------------------------------------------------------------
# S3 bucket
# ---------------------------------------------------------------------------
resource "aws_s3_bucket" "this" {
  bucket        = var.bucket_name
  force_destroy = false

  tags = local.common_tags
}

resource "aws_s3_bucket_versioning" "this" {
  bucket = aws_s3_bucket.this.id

  versioning_configuration {
    status = var.versioning == "enabled" ? "Enabled" : "Suspended"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = var.encryption == "aws-kms" ? "aws:kms" : "AES256"
      kms_master_key_id = var.encryption == "aws-kms" ? aws_kms_key.this[0].arn : null
    }
    bucket_key_enabled = var.encryption == "aws-kms"
  }
}

resource "aws_s3_bucket_public_access_block" "this" {
  bucket = aws_s3_bucket.this.id

  block_public_acls       = var.visibility == "private"
  block_public_policy     = var.visibility == "private"
  ignore_public_acls      = var.visibility == "private"
  restrict_public_buckets = var.visibility == "private"
}

resource "aws_s3_bucket_lifecycle_configuration" "this" {
  count  = var.versioning == "enabled" && var.expire_noncurrent_days > 0 ? 1 : 0
  bucket = aws_s3_bucket.this.id

  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"

    noncurrent_version_expiration {
      noncurrent_days = var.expire_noncurrent_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# ---------------------------------------------------------------------------
# Least-privilege IAM policy for owner service
# ---------------------------------------------------------------------------
data "aws_iam_policy_document" "bucket_access" {
  statement {
    sid    = "AllowBucketList"
    effect = "Allow"

    actions = [
      "s3:ListBucket",
      "s3:GetBucketLocation",
    ]

    resources = [aws_s3_bucket.this.arn]
  }

  statement {
    sid    = "AllowObjectOps"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
    ]

    resources = ["${aws_s3_bucket.this.arn}/*"]
  }

  dynamic "statement" {
    for_each = var.encryption == "aws-kms" ? [1] : []

    content {
      sid    = "AllowKmsAccess"
      effect = "Allow"

      actions = [
        "kms:GenerateDataKey",
        "kms:Decrypt",
        "kms:DescribeKey",
      ]

      resources = [aws_kms_key.this[0].arn]
    }
  }
}

resource "aws_iam_policy" "bucket_access" {
  name        = "${var.bucket_name}-access"
  description = "Least-privilege access to ${var.bucket_name} for ${var.owner_service}"
  policy      = data.aws_iam_policy_document.bucket_access.json

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# Locals
# ---------------------------------------------------------------------------
locals {
  common_tags = {
    "managed-by"    = "idp-backstage"
    "bucket-name"   = var.bucket_name
    "owner-service" = var.owner_service
    "visibility"    = var.visibility
  }
}
