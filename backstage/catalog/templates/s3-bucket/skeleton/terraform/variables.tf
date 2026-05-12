variable "bucket_name" {
  description = "S3 bucket name (globally unique)"
  type        = string
  default     = "${{ values.bucketName }}"
}

variable "owner_service" {
  description = "Service that will access this bucket — IAM policy is named after it"
  type        = string
  default     = "${{ values.ownerService }}"
}

variable "aws_region" {
  description = "AWS region to create the bucket in"
  type        = string
  default     = "${{ values.awsRegion }}"
}

variable "visibility" {
  description = "Bucket visibility: private or public-read"
  type        = string
  default     = "${{ values.visibility }}"

  validation {
    condition     = contains(["private", "public-read"], var.visibility)
    error_message = "visibility must be 'private' or 'public-read'"
  }
}

variable "versioning" {
  description = "Enable S3 object versioning"
  type        = string
  default     = "${{ values.versioning }}"

  validation {
    condition     = contains(["enabled", "disabled"], var.versioning)
    error_message = "versioning must be 'enabled' or 'disabled'"
  }
}

variable "expire_noncurrent_days" {
  description = "Days after which noncurrent object versions are deleted (0 = disabled)"
  type        = number
  default     = ${{ values.expireNoncurrentDays }}
}

variable "encryption" {
  description = "Server-side encryption type: aws-kms or AES256"
  type        = string
  default     = "${{ values.encryption }}"

  validation {
    condition     = contains(["aws-kms", "AES256"], var.encryption)
    error_message = "encryption must be 'aws-kms' or 'AES256'"
  }
}
