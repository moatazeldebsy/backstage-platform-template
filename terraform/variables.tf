variable "aws_region" {
  description = "AWS region for all resources"
  type        = string
  default     = "us-east-1"
}

variable "github_org" {
  description = "GitHub organisation or username that owns the IDP repos (used in OIDC trust policy)"
  type        = string
}

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
  default     = "dev"
}

variable "cluster_name" {
  description = "EKS cluster name"
  type        = string
  default     = "idp-mvp"
}

variable "cluster_version" {
  description = "Kubernetes version for EKS cluster"
  type        = string
  default     = "1.32"
}

variable "vpc_cidr" {
  description = "CIDR block for VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "node_instance_types" {
  description = "EC2 instance types for EKS node group"
  type        = list(string)
  default     = ["t3.medium"]
}

variable "node_group_min_size" {
  description = "Minimum number of nodes"
  type        = number
  default     = 2
}

variable "node_group_max_size" {
  description = "Maximum number of nodes"
  type        = number
  default     = 5
}

variable "node_group_desired_size" {
  description = "Desired number of nodes"
  type        = number
  default     = 2
}

variable "ecr_repositories" {
  description = "List of ECR repository names to create"
  type        = list(string)
  default     = ["hello-service", "idp-mcp-server", "qa-mcp-server"]
}

variable "rds_instance_class" {
  description = "RDS instance class for Backstage PostgreSQL"
  type        = string
  default     = "db.t3.micro"
}

variable "rds_db_name" {
  description = "PostgreSQL database name for Backstage"
  type        = string
  default     = "backstage"
}

variable "rds_username" {
  description = "PostgreSQL master username for Backstage"
  type        = string
  default     = "backstage"
}

# ── FinOps variables ──────────────────────────────────────────────────────────
variable "budget_monthly_limit_usd" {
  description = "Monthly AWS budget cap in USD. An alert fires at 80% (actual) and 100% (forecasted)."
  type        = string
  default     = "500"
}

variable "budget_alert_email" {
  description = "Email address that receives budget alert notifications"
  type        = string
  default     = ""
}

variable "slack_webhook_secret_name" {
  description = "AWS Secrets Manager secret name containing the Slack webhook URL (key: 'url')"
  type        = string
  default     = "idp-mvp/slack-webhook"
}

# ── Cost Optimizer variables ──────────────────────────────────────────────────
variable "enable_cost_optimizer" {
  description = "Enable overnight EKS node scale-down and RDS stop/start to reduce idle costs"
  type        = bool
  default     = false
}

variable "cost_optimizer_scale_down_cron" {
  description = "EventBridge cron expression (UTC) for scaling down. Default: 8 pm UTC daily."
  type        = string
  default     = "cron(0 20 * * ? *)"
}

variable "cost_optimizer_scale_up_cron" {
  description = "EventBridge cron expression (UTC) for scaling back up. Default: 7 am UTC daily."
  type        = string
  default     = "cron(0 7 * * ? *)"
}

# ── AI/ML variables ───────────────────────────────────────────────────────────
variable "anthropic_api_key" {
  description = "Anthropic API key for KAgent (Claude). Stored in Secrets Manager (idp-mvp/kagent)."
  type        = string
  sensitive   = true
  default     = "REPLACE_ME"
}
