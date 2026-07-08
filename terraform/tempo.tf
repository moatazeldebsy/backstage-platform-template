# Tempo trace storage — S3 bucket + IRSA role for the tempo-distributed
# deployment (aws/observability/tempo/tempo-values.yaml). The chart uses a
# single shared ServiceAccount ("tempo" in the monitoring namespace) across
# distributor/ingester/querier/compactor components.

resource "aws_s3_bucket" "tempo_traces" {
  bucket = "idp-mvp-tempo-traces-${data.aws_caller_identity.current.account_id}"

  tags = {
    Name = "idp-mvp-tempo-traces"
  }
}

resource "aws_s3_bucket_versioning" "tempo_traces" {
  bucket = aws_s3_bucket.tempo_traces.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "tempo_traces" {
  bucket = aws_s3_bucket.tempo_traces.id

  rule {
    id     = "expire-old-versions-and-traces"
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

resource "aws_s3_bucket_server_side_encryption_configuration" "tempo_traces" {
  bucket = aws_s3_bucket.tempo_traces.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "tempo_traces" {
  bucket = aws_s3_bucket.tempo_traces.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

module "tempo_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.30"

  role_name = "${var.cluster_name}-tempo"

  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["monitoring:tempo"]
    }
  }
}

resource "aws_iam_role_policy" "tempo" {
  name = "tempo-s3-traces"
  role = module.tempo_irsa.iam_role_name

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
          aws_s3_bucket.tempo_traces.arn,
          "${aws_s3_bucket.tempo_traces.arn}/*"
        ]
      }
    ]
  })
}

output "tempo_traces_bucket_name" {
  description = "S3 bucket name for Tempo trace storage"
  value       = aws_s3_bucket.tempo_traces.id
}

output "tempo_role_arn" {
  description = "IAM role ARN for the Tempo ServiceAccount (IRSA) — S3 trace storage access"
  value       = module.tempo_irsa.iam_role_arn
}
