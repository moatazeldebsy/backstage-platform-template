# Platform S3 buckets — shared infrastructure used by multiple global components.
#
#   idp-mvp-thanos-metrics      → Thanos long-term metrics storage (both sidecars write here)
#   idp-mvp-platform-logs       → Global Accelerator flow logs + CloudFront access logs
#
# Both buckets are in eu-central-1 (primary). The Thanos bucket uses S3 CRR to us-east-1
# so the Thanos Store Gateway in a failed-over cluster can still read historical data.

# ── Thanos metrics bucket ──────────────────────────────────────────────────────

resource "aws_s3_bucket" "thanos_metrics" {
  bucket        = "idp-mvp-thanos-metrics-${data.aws_caller_identity.current.account_id}"
  force_destroy = false

  tags = { Name = "idp-mvp-thanos-metrics", Purpose = "thanos-long-term-storage" }
}

resource "aws_s3_bucket_versioning" "thanos_metrics" {
  bucket = aws_s3_bucket.thanos_metrics.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "thanos_metrics" {
  bucket = aws_s3_bucket.thanos_metrics.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.primary.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "thanos_metrics" {
  bucket                  = aws_s3_bucket.thanos_metrics.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Lifecycle: Thanos compactor manages raw retention (30d), but S3 is the safety net
resource "aws_s3_bucket_lifecycle_configuration" "thanos_metrics" {
  bucket = aws_s3_bucket.thanos_metrics.id

  rule {
    id     = "expire-raw-blocks"
    status = "Enabled"
    filter { prefix = "" }
    expiration { days = 45 }   # slightly longer than Thanos 30d raw retention
  }
}

# Replicate to standby region so Thanos can serve data after failover
resource "aws_s3_bucket_replication_configuration" "thanos_metrics" {
  bucket = aws_s3_bucket.thanos_metrics.id
  role   = aws_iam_role.s3_replication.arn

  rule {
    id     = "replicate-to-standby"
    status = "Enabled"
    filter { prefix = "" }

    destination {
      bucket        = aws_s3_bucket.thanos_metrics_replica.arn
      storage_class = "STANDARD_IA"   # cheaper — read only during failover
    }

    delete_marker_replication { status = "Enabled" }
  }

  depends_on = [aws_s3_bucket_versioning.thanos_metrics]
}

# Thanos replica bucket in us-east-1
resource "aws_s3_bucket" "thanos_metrics_replica" {
  provider      = aws.standby
  bucket        = "idp-mvp-thanos-metrics-replica-${data.aws_caller_identity.current.account_id}"
  force_destroy = false

  tags = { Name = "idp-mvp-thanos-metrics-replica", Purpose = "thanos-failover-storage" }
}

resource "aws_s3_bucket_versioning" "thanos_metrics_replica" {
  provider = aws.standby
  bucket   = aws_s3_bucket.thanos_metrics_replica.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_public_access_block" "thanos_metrics_replica" {
  provider                = aws.standby
  bucket                  = aws_s3_bucket.thanos_metrics_replica.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ── Platform logs bucket ───────────────────────────────────────────────────────

resource "aws_s3_bucket" "platform_logs" {
  bucket        = "idp-mvp-platform-logs-${data.aws_caller_identity.current.account_id}"
  force_destroy = false

  tags = { Name = "idp-mvp-platform-logs", Purpose = "ga-cloudfront-access-logs" }
}

resource "aws_s3_bucket_public_access_block" "platform_logs" {
  bucket                  = aws_s3_bucket.platform_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "platform_logs" {
  bucket = aws_s3_bucket.platform_logs.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "platform_logs" {
  bucket = aws_s3_bucket.platform_logs.id

  rule {
    id     = "expire-old-logs"
    status = "Enabled"
    filter { prefix = "" }
    expiration { days = 90 }
  }
}

# ── Outputs ───────────────────────────────────────────────────────────────────

output "thanos_metrics_bucket" {
  description = "Thanos metrics S3 bucket name — update thanos/argocd-application.yaml objstoreConfig"
  value       = aws_s3_bucket.thanos_metrics.id
}

output "platform_logs_bucket" {
  description = "Platform logs S3 bucket name — used by Global Accelerator and CloudFront"
  value       = aws_s3_bucket.platform_logs.id
}
