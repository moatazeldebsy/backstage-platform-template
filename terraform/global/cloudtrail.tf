# CloudTrail organization trail — multi-region audit logging.
# All API calls across both regions are captured and stored in S3 with CRR.
# Useful for incident investigation, compliance, and Security Hub correlation.

resource "aws_s3_bucket" "cloudtrail" {
  bucket        = "idp-mvp-cloudtrail-${data.aws_caller_identity.current.account_id}"
  force_destroy = false

  tags = { Name = "idp-mvp-cloudtrail-logs" }
}

resource "aws_s3_bucket_versioning" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.primary.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "cloudtrail" {
  bucket                  = aws_s3_bucket.cloudtrail.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_policy" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AWSCloudTrailAclCheck"
        Effect = "Allow"
        Principal = { Service = "cloudtrail.amazonaws.com" }
        Action   = "s3:GetBucketAcl"
        Resource = aws_s3_bucket.cloudtrail.arn
      },
      {
        Sid    = "AWSCloudTrailWrite"
        Effect = "Allow"
        Principal = { Service = "cloudtrail.amazonaws.com" }
        Action   = "s3:PutObject"
        Resource = "${aws_s3_bucket.cloudtrail.arn}/AWSLogs/${data.aws_caller_identity.current.account_id}/*"
        Condition = {
          StringEquals = { "s3:x-amz-acl" = "bucket-owner-full-control" }
        }
      }
    ]
  })
}

# Multi-region trail — captures events from all AWS regions in one trail
resource "aws_cloudtrail" "platform" {
  name                          = "idp-mvp-platform-trail"
  s3_bucket_name                = aws_s3_bucket.cloudtrail.id
  include_global_service_events = true
  is_multi_region_trail         = true
  enable_log_file_validation    = true
  kms_key_id                    = aws_kms_key.primary.arn

  event_selector {
    read_write_type           = "All"
    include_management_events = true

    # Log all S3 data events (object-level) for the CloudTrail bucket itself
    data_resource {
      type   = "AWS::S3::Object"
      values = ["${aws_s3_bucket.cloudtrail.arn}/"]
    }
  }

  tags = {
    Name = "idp-mvp-cloudtrail"
  }

  depends_on = [aws_s3_bucket_policy.cloudtrail]
}
