output "bucket_id" {
  description = "S3 bucket name"
  value       = aws_s3_bucket.this.id
}

output "bucket_arn" {
  description = "S3 bucket ARN"
  value       = aws_s3_bucket.this.arn
}

output "bucket_regional_domain_name" {
  description = "Regional domain name for the S3 bucket"
  value       = aws_s3_bucket.this.bucket_regional_domain_name
}

output "iam_policy_arn" {
  description = "ARN of the least-privilege IAM policy to attach to your service role"
  value       = aws_iam_policy.bucket_access.arn
}

output "iam_policy_name" {
  description = "Name of the least-privilege IAM policy"
  value       = aws_iam_policy.bucket_access.name
}

output "kms_key_arn" {
  description = "KMS key ARN (empty if AES256 encryption)"
  value       = var.encryption == "aws-kms" ? aws_kms_key.this[0].arn : ""
}
