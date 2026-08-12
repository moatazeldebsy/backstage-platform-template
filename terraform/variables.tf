variable "aws_region" {
  description = "AWS region for all resources"
  type        = string
  default     = "eu-central-1"
}

variable "secondary_region" {
  description = "Secondary (standby) AWS region for replication and failover"
  type        = string
  default     = "us-east-1"
}

variable "is_primary_region" {
  description = "Set to true for the primary region (eu-central-1). Controls whether Secrets Manager CRR replicas are created — only the primary replicates to the secondary."
  type        = bool
  default     = true
}

variable "enable_multi_az_nat" {
  description = "Deploy one NAT gateway per AZ instead of a single shared one. Required for production HA; costs ~$100/month extra per region."
  type        = bool
  default     = false
}

variable "domain_name" {
  description = "Root domain name managed in Route 53 (e.g. idp.example.com). Used by the global module for health-check and failover DNS records."
  type        = string
  default     = ""
}

variable "github_org" {
  description = "GitHub organisation or username that owns the IDP repos (used in OIDC trust policy)"
  type        = string
}

variable "platform_repo" {
  description = <<-EOT
    Name of the platform repository allowed to assume the GitHub Actions role.
    Scopes the OIDC trust policy to a single repo rather than the whole org —
    important because the scaffolder creates new repos under the same org, and
    the role carries PowerUserAccess + IAMFullAccess. Mirrors PLATFORM_REPO in
    .idp-config.env.
  EOT
  type        = string
  default     = "backstage-platform-template"
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
  description = <<-EOT
    EC2 instance types for the EKS node group.

    Sized by POD IP capacity, not CPU/RAM. The AWS VPC CNI assigns each pod a real
    subnet IP from the node's ENIs, so max-pods-per-node is a property of the
    instance type: t3.medium allows 17, t3.large allows 35. The full platform is
    ~110 pods (~90 before the AI/ML layer), so 6x t3.medium caps out at 102 and pods
    fail to schedule with

      aws-cni failed (add): add cmd: failed to assign an IP address to container

    Observed 2026-08-12: every node pinned at 17/17, the kube-prometheus admission
    hook stuck in CrashLoopBackOff, and the DORA and flaky-test exporter CronJobs
    all failing. CPU and memory were never the constraint.
  EOT
  type        = list(string)
  default     = ["t3.large"]
}

variable "memory_optimized_instance_types" {
  description = "EC2 instance types for the memory-optimised node group (Prometheus, MLflow, and other memory-heavy workloads that opt in via the role=memory-optimized nodeSelector + toleration). Scales to zero by default — no cost unless something actually schedules onto it."
  type        = list(string)
  default     = ["r5.large"]
}

variable "node_group_min_size" {
  description = "Minimum number of nodes (0 allows scale-to-zero via cost optimizer)"
  type        = number
  default     = 0
}

variable "node_group_max_size" {
  description = "Maximum number of nodes"
  type        = number
  default     = 2
}

variable "node_group_desired_size" {
  description = "Desired number of nodes"
  type        = number
  default     = 1
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

variable "rds_multi_az" {
  description = "Enable Multi-AZ standby for RDS (recommended for Medium/Large tiers)"
  type        = bool
  default     = false
}

variable "rds_backup_retention_days" {
  description = "Number of days to retain automated RDS backups"
  type        = number
  default     = 30
}

variable "rds_allocated_storage" {
  description = "Allocated storage in GB for RDS instance"
  type        = number
  default     = 20
}

variable "enable_karpenter" {
  description = "Install Karpenter for intelligent node autoscaling (recommended for Medium/Large tiers)"
  type        = bool
  default     = false
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

variable "langfuse_rds_instance_class" {
  description = "RDS instance class for the Langfuse PostgreSQL database. Langfuse's Postgres holds only metadata (users, API keys, projects, prompts) — the high-volume trace data lives in ClickHouse — so this stays smaller than the Backstage instance."
  type        = string
  default     = "db.t4g.micro"
}

# ── FinOps variables ──────────────────────────────────────────────────────────
variable "budget_monthly_limit_usd" {
  description = "Monthly AWS budget cap in USD. An alert fires at 80% (actual) and 100% (forecasted)."
  type        = string
  default     = "100"
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
  default     = true
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

variable "dora_github_token" {
  description = <<-EOT
    GitHub PAT (repo:read) for the DORA exporter. Stored in Secrets Manager at
    idp-mvp/dora-exporter.

    Previously the secret version hardcoded "REPLACE_ME", so the exporter
    authenticated with that literal string and every run died on

      401 Client Error: Unauthorized for url:
      https://api.github.com/search/repositories?q=user:<org>+topic:idp-app

    The CronJob failed every 15 minutes, no dora_* metrics were ever published, and
    Backstage's DORA tab showed demo data blaming missing catalog topics — which was
    misleading, since the exporter never got past its first API call. Worse, because
    Terraform owned the value, populating it by hand was reverted on the next apply.
    Observed 2026-08-13.
  EOT
  type        = string
  sensitive   = true
  default     = "REPLACE_ME"
}

variable "slack_webhook_url" {
  description = <<-EOT
    Slack incoming webhook for cost and budget alerts. Stored in Secrets Manager at
    idp-mvp/slack-webhook and read by the cost-alert Lambda.

    Same reasoning as dora_github_token: the secret version hardcoded "REPLACE_ME",
    so a hand-populated value was silently reverted by the next terraform apply.
  EOT
  type        = string
  sensitive   = true
  default     = "REPLACE_ME"
}

# ── Datadog variables ──────────────────────────────────────────────────────────
variable "datadog_api_key" {
  description = "Datadog API key. Stored in Secrets Manager (idp-mvp/datadog and idp-mvp/backstage)."
  type        = string
  sensitive   = true
  default     = "REPLACE_ME"
}

variable "datadog_app_key" {
  description = "Datadog Application key. Stored in Secrets Manager (idp-mvp/datadog and idp-mvp/backstage)."
  type        = string
  sensitive   = true
  default     = "REPLACE_ME"
}
