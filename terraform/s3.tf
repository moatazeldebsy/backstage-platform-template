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
