variable "aws_region" {
  description = "AWS region for all resources"
  type        = string
  default     = "eu-central-1"
}

variable "enable_multi_az_nat" {
  description = "Deploy one NAT gateway per AZ instead of a single shared one. With the default single NAT, an outage in its AZ cuts egress for every private subnet. Set true for production (profiles/medium + large do); costs ~$65-100/month extra. See ADR-0009."
  type        = bool
  default     = false
}

variable "domain_name" {
  description = "Root domain name managed in Route 53 (e.g. idp.example.com). Used for the ACM certificate and its DNS validation records."
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
    the role can push to every service's ECR repo and is cluster-admin in EKS.
    Mirrors PLATFORM_REPO in
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
  description = "Kubernetes version for EKS cluster. Keep this on a version in EKS *standard* support: once a version leaves it, the control plane bills extended support at $0.60/h instead of $0.10/h (6x). 1.32 crossed that line on 2026-03-23 and was costing ~$0.50/h extra. Check with: aws eks describe-cluster-versions --query 'clusterVersions[].[clusterVersion,versionStatus]'"
  type        = string
  default     = "1.35"
}

variable "vpc_cidr" {
  description = "CIDR block for VPC"
  type        = string
  default     = "10.0.0.0/16"

  # AWS only accepts /16–/28 on a VPC. vpc.tf also carves subnets with
  # cidrsubnet(vpc_cidr, 4, i) for up to 8 of them, which needs at least a /24.
  validation {
    condition     = try(tonumber(split("/", var.vpc_cidr)[1]) >= 16 && tonumber(split("/", var.vpc_cidr)[1]) <= 24 && can(cidrhost(var.vpc_cidr, 0)), false)
    error_message = "vpc_cidr must be a valid IPv4 CIDR between /16 and /24 (AWS rejects VPCs larger than /16)."
  }
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

# ── AI/ML layer ───────────────────────────────────────────────────────────────
# The AI/ML stack (KAgent, MLflow, Langfuse, the MCP servers) is an opt-in layer
# on AWS, matching how local works: bootstrap-local.sh installs the core and
# bootstrap-ai.sh adds AI. This gates the *infrastructure* half of that split.
#
# It used to be unconditional, so `bootstrap.sh --skip-ai` skipped the workloads
# but still provisioned a second RDS instance and two S3 buckets — the flag saved
# no money at all, which is the main reason anyone reaches for it.
#
# bootstrap-ai.sh --aws sets this to true before it applies.
variable "enable_ai" {
  description = "Provision the AI/ML layer's infrastructure (MLflow + Langfuse S3 buckets and their IRSA roles). Set automatically by scripts/bootstrap-ai.sh --aws."
  type        = bool
  default     = false
}

# Separate from enable_ai because Langfuse is the expensive part — it is the only
# component here that needs a dedicated RDS instance. Running the AI stack without
# LLM tracing is a reasonable thing to want.
variable "enable_langfuse" {
  description = "Provision the Langfuse Postgres RDS instance and its Secrets Manager entry. Requires enable_ai."
  type        = bool
  default     = false
}

# Discovered necessary post-ADR-0008: LiteLLM's virtual keys and budget
# enforcement — the actual reason it was chosen over agentgateway's native
# Bedrock support — do not function without a database ("Not connected to DB!"
# on /ui login, and budgets silently unenforced at request time). Same
# dedicated-RDS-per-stateful-component pattern as Langfuse above, not shared
# with Backstage's instance. Set automatically by scripts/bootstrap-ai.sh --aws
# from the --litellm flag.
variable "enable_litellm" {
  description = "Provision the LiteLLM Postgres RDS instance and its Secrets Manager entry. Requires enable_ai."
  type        = bool
  default     = false
}

variable "litellm_rds_instance_class" {
  description = "RDS instance class for LiteLLM's PostgreSQL database (virtual keys, spend tracking). Small — this holds proxy metadata, not application data."
  type        = string
  default     = "db.t4g.micro"
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

variable "litellm_master_key" {
  description = <<-EOT
    Inbound-auth key for the LiteLLM proxy (kubernetes/ml-platform/litellm.yaml,
    ADR-0008). Distinct from anthropic_api_key above: this is what callers
    (agentgateway, the LiteLLM /ui dashboard) present to LiteLLM, not what
    LiteLLM presents to Anthropic/Bedrock. Stored alongside it in the same
    Secrets Manager entry (idp-mvp/kagent) — see aws_secretsmanager_secret_version.kagent
    in secrets.tf.
  EOT
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

# ── Incident / issue tracker variables ────────────────────────────────────────
# All optional. Left at REPLACE_ME the corresponding Backstage tab renders its
# empty state rather than erroring — the same soft-fail behaviour the local
# path has via a blank value in local/backstage/.env.
variable "pagerduty_token" {
  description = "PagerDuty REST API key (read-only is sufficient). Used by the Backstage /pagerduty proxy in app-config.aws.yaml. Leave at REPLACE_ME to render the On-Call tab's empty state."
  type        = string
  sensitive   = true
  default     = "REPLACE_ME"
}

variable "jira_token" {
  description = "Jira credential for the Backstage /jira proxy: Base64(email:api_token). Leave at REPLACE_ME to render the Issues tab's empty state."
  type        = string
  sensitive   = true
  default     = "REPLACE_ME"
}

variable "jira_url" {
  description = "Base URL of the Jira instance, e.g. https://your-company.atlassian.net. Not a secret, but travels with JIRA_TOKEN so the proxy gets both from one place. Empty leaves app-config.aws.yaml on its RFC 2606 .invalid default, which never resolves."
  type        = string
  default     = ""
}

# ── Reliability hardening (on in profiles/medium + large) ─────────────────────

variable "secret_recovery_window_days" {
  description = "Recovery window for Terraform-managed Secrets Manager secrets. 0 deletes immediately (dev: lets destroy + re-bootstrap reuse the same names). 7-30 makes an accidental delete or a bad apply recoverable with `aws secretsmanager restore-secret`; cleanup.sh force-deletes them after terraform destroy either way."
  type        = number
  default     = 0

  validation {
    condition     = var.secret_recovery_window_days == 0 || (var.secret_recovery_window_days >= 7 && var.secret_recovery_window_days <= 30)
    error_message = "secret_recovery_window_days must be 0 or between 7 and 30 (the Secrets Manager limits)."
  }
}

variable "rds_max_allocated_storage" {
  description = "Upper bound in GB for RDS storage autoscaling on the Backstage instance. Storage grows automatically (no downtime) when free space runs low, instead of the instance going read-only. 0 disables autoscaling."
  type        = number
  default     = 100
}

variable "rds_performance_insights_enabled" {
  description = "Enable Performance Insights (7-day retention, free tier) on the Backstage RDS instance. Not supported on db.t3.micro / db.t4g.micro, so off by default and enabled by the medium/large profiles."
  type        = bool
  default     = false
}

variable "enable_vpc_interface_endpoints" {
  description = "Create interface VPC endpoints (ECR api/dkr, STS, Secrets Manager, CloudWatch Logs) so image pulls, IRSA token exchange and secret sync keep working without NAT, and stop paying NAT per-GB for that traffic. About $7/month per endpoint per AZ (~$110/month for 5 x 3 AZs). The S3 gateway endpoint is free and always created."
  type        = bool
  default     = false
}

variable "enable_grafana_db" {
  description = "Give Grafana a dedicated Postgres (terraform/grafana.tf) instead of in-pod SQLite. Without it Grafana's users, sessions and service-account tokens (incl. Backstage's GRAFANA_TOKEN) are lost on every pod restart, and Grafana cannot run more than one replica."
  type        = bool
  default     = true
}

variable "grafana_rds_instance_class" {
  description = "RDS instance class for Grafana's Postgres. It holds Grafana's own metadata only (users, sessions, dashboards), not metrics."
  type        = string
  default     = "db.t4g.micro"
}

variable "node_capacity_type" {
  description = "Capacity type for the platform node group: SPOT or ON_DEMAND. null (default) picks SPOT unless environment = \"prod\" (profiles/medium and large), since this platform is rebuilt from IaC and spot is ~60-70% cheaper. EKS drains a spot node when AWS reclaims it, and the pods reschedule."
  type        = string
  default     = null

  validation {
    condition     = var.node_capacity_type == null || contains(["SPOT", "ON_DEMAND"], coalesce(var.node_capacity_type, "SPOT"))
    error_message = "node_capacity_type must be SPOT, ON_DEMAND or null."
  }
}

variable "s3_bucket_suffix" {
  description = "Appended to the platform's S3 bucket names (idp-mvp-<purpose>-<account><suffix>). Leave empty normally. S3 names are global and these include no region, so rebuilding in another region of the same account while the old buckets still exist (a regional outage) needs a suffix, e.g. \"-usw2\". See docs/runbooks/regional-rebuild.md."
  type        = string
  default     = ""

  validation {
    condition     = can(regex("^(-[a-z0-9]+)*$", var.s3_bucket_suffix)) && length(var.s3_bucket_suffix) <= 12
    error_message = "s3_bucket_suffix must be empty or like \"-usw2\": lowercase letters, digits and hyphens, starting with a hyphen, at most 12 characters."
  }
}
