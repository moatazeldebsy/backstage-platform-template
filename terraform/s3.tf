resource "aws_s3_bucket" "techdocs" {
  bucket = "idp-mvp-techdocs-${data.aws_caller_identity.current.account_id}"

  tags = {
    Name = "idp-mvp-techdocs"
  }
}

resource "aws_s3_bucket_versioning" "techdocs" {
  bucket = aws_s3_bucket.techdocs.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "techdocs" {
  bucket = aws_s3_bucket.techdocs.id

  rule {
    id     = "expire-old-versions"
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

resource "aws_s3_bucket_server_side_encryption_configuration" "techdocs" {
  bucket = aws_s3_bucket.techdocs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "techdocs" {
  bucket = aws_s3_bucket.techdocs.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

output "techdocs_bucket_name" {
  description = "S3 bucket name for TechDocs"
  value       = aws_s3_bucket.techdocs.id
}

# ── MLflow artifact storage ─────────────────────────────────────────────────────────
resource "aws_s3_bucket" "mlflow_artifacts" {
  count = var.enable_ai ? 1 : 0

  bucket = "idp-mvp-mlflow-${data.aws_caller_identity.current.account_id}"

  tags = {
    Name = "idp-mvp-mlflow-artifacts"
  }
}

resource "aws_s3_bucket_versioning" "mlflow_artifacts" {
  count = var.enable_ai ? 1 : 0

  bucket = aws_s3_bucket.mlflow_artifacts[0].id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "mlflow_artifacts" {
  count = var.enable_ai ? 1 : 0

  bucket = aws_s3_bucket.mlflow_artifacts[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "mlflow_artifacts" {
  count = var.enable_ai ? 1 : 0

  bucket = aws_s3_bucket.mlflow_artifacts[0].id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ── MLflow Lifecycle Policy: Clean up old artifacts to reduce costs ────────────
resource "aws_s3_bucket_lifecycle_configuration" "mlflow_artifacts" {
  count = var.enable_ai ? 1 : 0

  bucket = aws_s3_bucket.mlflow_artifacts[0].id

  rule {
    id     = "delete-old-artifacts"
    status = "Enabled"
    filter {}

    # Delete non-current versions after 30 days
    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    # Delete incomplete multipart uploads after 7 days
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }

    # Optional: Transition old artifacts to Glacier (not delete) for compliance
    # Uncomment to enable cost optimization
    # noncurrent_version_transition {
    #   noncurrent_days = 60
    #   storage_class   = "GLACIER"
    # }
  }
}

# ── MLflow S3 Bucket Metrics for cost monitoring ────────────────────────────────
resource "aws_s3_bucket_metric" "mlflow_artifacts_size" {
  count = var.enable_ai ? 1 : 0

  bucket = aws_s3_bucket.mlflow_artifacts[0].id
  name   = "EntireBucket"
}

output "mlflow_artifacts_bucket_name" {
  description = "S3 bucket name for MLflow artifact storage"
  value       = one(aws_s3_bucket.mlflow_artifacts[*].id)
}

# ── Langfuse blob storage ───────────────────────────────────────────────────────
# Langfuse writes raw trace events, multi-modal media and batch exports here.
# Locally this role is played by the bundled MinIO subchart; on EKS it is a real
# bucket reached via IRSA (see module.langfuse_irsa in iam.tf).
resource "aws_s3_bucket" "langfuse_blobs" {
  count = var.enable_ai ? 1 : 0

  bucket = "idp-mvp-langfuse-${data.aws_caller_identity.current.account_id}"

  tags = {
    Name = "idp-mvp-langfuse-blobs"
  }
}

# Deliberately NOT versioned, unlike the MLflow bucket. Langfuse treats these
# objects as immutable, write-once event payloads and never updates one in
# place, so versioning would only duplicate storage cost with no recovery value.
resource "aws_s3_bucket_server_side_encryption_configuration" "langfuse_blobs" {
  count = var.enable_ai ? 1 : 0

  bucket = aws_s3_bucket.langfuse_blobs[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "langfuse_blobs" {
  count = var.enable_ai ? 1 : 0

  bucket = aws_s3_bucket.langfuse_blobs[0].id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Trace payloads are high-volume and lose value quickly. ClickHouse holds the
# queryable copy; these blobs are the raw ingest record behind it.
resource "aws_s3_bucket_lifecycle_configuration" "langfuse_blobs" {
  count = var.enable_ai ? 1 : 0

  bucket = aws_s3_bucket.langfuse_blobs[0].id

  rule {
    id     = "expire-old-events"
    status = "Enabled"
    filter {}

    expiration {
      days = 90
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

resource "aws_s3_bucket_metric" "langfuse_blobs_size" {
  count = var.enable_ai ? 1 : 0

  bucket = aws_s3_bucket.langfuse_blobs[0].id
  name   = "EntireBucket"
}

output "langfuse_blobs_bucket_name" {
  description = "S3 bucket name for Langfuse blob storage (trace events, media, exports)"
  value       = one(aws_s3_bucket.langfuse_blobs[*].id)
}

# ── Velero cluster backup storage ───────────────────────────────────────────────────
resource "aws_s3_bucket" "velero_backups" {
  bucket = "idp-mvp-velero-${data.aws_caller_identity.current.account_id}"

  tags = {
    Name = "idp-mvp-velero-backups"
  }
}

resource "aws_s3_bucket_versioning" "velero_backups" {
  bucket = aws_s3_bucket.velero_backups.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "velero_backups" {
  bucket = aws_s3_bucket.velero_backups.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "velero_backups" {
  bucket = aws_s3_bucket.velero_backups.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Backups are the whole point of this bucket — expire old ones rather than
# growing unbounded, but don't let normal lifecycle churn delete a backup
# before Velero's own --default-backup-ttl (720h / 30 days) would.
resource "aws_s3_bucket_lifecycle_configuration" "velero_backups" {
  bucket = aws_s3_bucket.velero_backups.id

  rule {
    id     = "expire-old-backups"
    status = "Enabled"
    filter {}

    expiration {
      days = 90
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

output "velero_backups_bucket_name" {
  description = "S3 bucket name for Velero cluster backups"
  value       = aws_s3_bucket.velero_backups.id
}
