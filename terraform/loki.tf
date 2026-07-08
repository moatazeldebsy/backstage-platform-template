# Loki chunk storage — S3 bucket + IRSA role for the SimpleScalable Loki
# deployment (aws/observability/loki/loki-values.yaml). The chart uses a
# single shared ServiceAccount ("loki" in the monitoring namespace) across
# read/write/backend components.

resource "aws_s3_bucket" "loki_chunks" {
  bucket = "idp-mvp-loki-chunks-${data.aws_caller_identity.current.account_id}"

  tags = {
    Name = "idp-mvp-loki-chunks"
  }
}

resource "aws_s3_bucket_versioning" "loki_chunks" {
  bucket = aws_s3_bucket.loki_chunks.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "loki_chunks" {
  bucket = aws_s3_bucket.loki_chunks.id

  rule {
    id     = "expire-old-versions-and-chunks"
    status = "Enabled"
    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "loki_chunks" {
  bucket = aws_s3_bucket.loki_chunks.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "loki_chunks" {
  bucket = aws_s3_bucket.loki_chunks.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

module "loki_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.30"

  role_name = "${var.cluster_name}-loki"

  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["monitoring:loki"]
    }
  }
}

resource "aws_iam_role_policy" "loki" {
  name = "loki-s3-chunks"
  role = module.loki_irsa.iam_role_name

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
          aws_s3_bucket.loki_chunks.arn,
          "${aws_s3_bucket.loki_chunks.arn}/*"
        ]
      }
    ]
  })
}

output "loki_chunks_bucket_name" {
  description = "S3 bucket name for Loki chunk/index storage"
  value       = aws_s3_bucket.loki_chunks.id
}

output "loki_role_arn" {
  description = "IAM role ARN for the Loki ServiceAccount (IRSA) — S3 chunk storage access"
  value       = module.loki_irsa.iam_role_arn
}
