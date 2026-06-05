variable "primary_region" {
  description = "Primary AWS region (eu-central-1)"
  type        = string
  default     = "eu-central-1"
}

variable "standby_region" {
  description = "Standby AWS region (us-east-1)"
  type        = string
  default     = "us-east-1"
}

variable "domain_name" {
  description = "Root domain for the IDP platform (e.g. idp.example.com)"
  type        = string
}

variable "primary_alb_dns" {
  description = "DNS name of the ALB in the primary region (output from per-region Terraform apply)"
  type        = string
}

variable "standby_alb_dns" {
  description = "DNS name of the ALB in the standby region (output from per-region Terraform apply)"
  type        = string
}

variable "primary_alb_zone_id" {
  description = "Route 53 hosted zone ID of the ALB in the primary region"
  type        = string
}

variable "standby_alb_zone_id" {
  description = "Route 53 hosted zone ID of the ALB in the standby region"
  type        = string
}

variable "health_check_path" {
  description = "HTTP path used by Route 53 health checks to probe each ALB"
  type        = string
  default     = "/healthcheck"
}

# ── Aurora Global Database variables ──────────────────────────────────────────

variable "primary_vpc_id" {
  description = "VPC ID in eu-central-1 (from per-region Terraform output vpc_id)"
  type        = string
}

variable "primary_vpc_cidr" {
  description = "VPC CIDR in eu-central-1 (10.0.0.0/16)"
  type        = string
  default     = "10.0.0.0/16"
}

variable "primary_private_subnet_ids" {
  description = "Private subnet IDs in eu-central-1 (from per-region Terraform output)"
  type        = list(string)
}

variable "standby_vpc_id" {
  description = "VPC ID in us-east-1 (from per-region Terraform output vpc_id)"
  type        = string
}

variable "standby_vpc_cidr" {
  description = "VPC CIDR in us-east-1 (10.1.0.0/16)"
  type        = string
  default     = "10.1.0.0/16"
}

variable "standby_private_subnet_ids" {
  description = "Private subnet IDs in us-east-1 (from per-region Terraform output)"
  type        = list(string)
}

variable "rds_db_name" {
  description = "PostgreSQL database name for Backstage Aurora cluster"
  type        = string
  default     = "backstage"
}

variable "rds_username" {
  description = "PostgreSQL master username for Backstage Aurora cluster"
  type        = string
  default     = "backstage"
}

variable "rds_instance_class" {
  description = "Aurora instance class"
  type        = string
  default     = "db.r6g.large"
}

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
  default     = "prod"
}

# ── Global Accelerator + CloudFront variables ──────────────────────────────────

variable "primary_alb_arn" {
  description = "ARN of the ALB in eu-central-1 (from ingress controller)"
  type        = string
}

variable "standby_alb_arn" {
  description = "ARN of the ALB in us-east-1 (from ingress controller)"
  type        = string
}

variable "logs_s3_bucket" {
  description = "S3 bucket name for Global Accelerator flow logs and CloudFront access logs"
  type        = string
  default     = "idp-mvp-platform-logs"
}

variable "security_alert_email" {
  description = "Email address for CRITICAL/HIGH Security Hub finding alerts. Leave empty to disable."
  type        = string
  default     = ""
}

variable "oidc_provider_arn" {
  description = "OIDC provider ARN of the primary EKS cluster — used by IRSA trust policies for failover-runner and other global roles. From per-region Terraform output: module.eks.oidc_provider_arn"
  type        = string
}
