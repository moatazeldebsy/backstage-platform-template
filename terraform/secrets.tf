resource "random_password" "backstage_session" {
  length  = 64
  special = false
}

# Signs Backstage's service-to-service tokens (backend.auth.keys). Distinct from
# the session secret above: this one was never supplied on EKS at all, so the
# base config's fallback applied and production signed with a literal published
# in this repository.
resource "random_password" "backstage_auth" {
  length  = 64
  special = false
}

resource "aws_secretsmanager_secret" "backstage" {
  name                    = "idp-mvp/backstage"
  description             = "Backstage IDP platform credentials"
  recovery_window_in_days = var.secret_recovery_window_days
}

resource "aws_secretsmanager_secret_version" "backstage" {
  secret_id = aws_secretsmanager_secret.backstage.id

  secret_string = jsonencode({
    POSTGRES_HOST             = aws_db_instance.backstage.address
    POSTGRES_PORT             = "5432"
    POSTGRES_USER             = var.rds_username
    POSTGRES_PASSWORD         = random_password.rds.result
    GITHUB_TOKEN              = "REPLACE_ME"
    AUTH_GITHUB_CLIENT_ID     = "REPLACE_ME"
    AUTH_GITHUB_CLIENT_SECRET = "REPLACE_ME"
    AUTH_SESSION_SECRET       = random_password.backstage_session.result
    BACKSTAGE_AUTH_SECRET     = random_password.backstage_auth.result
    K8S_CLUSTER_URL           = module.eks.cluster_endpoint
    K8S_CLUSTER_CA_DATA       = module.eks.cluster_certificate_authority_data
    K8S_SERVICE_ACCOUNT_TOKEN = "REPLACE_ME"
    TECHDOCS_S3_BUCKET_NAME   = aws_s3_bucket.techdocs.id
    AWS_REGION                = var.aws_region
    BACKSTAGE_CATALOG_TOKEN   = "REPLACE_ME"
    # Datadog — used by the Backstage backend's /datadog proxy (app-config.aws.yaml)
    # and by dd-trace APM instrumentation. Same keys also live in idp-mvp/datadog
    # for the cluster-wide Datadog Agent (see aws_secretsmanager_secret.datadog below).
    DD_API_KEY = var.datadog_api_key
    DD_APP_KEY = var.datadog_app_key
    # PagerDuty / Jira — used by the /pagerduty and /jira proxies in
    # app-config.aws.yaml. These were referenced by that config but never
    # supplied on EKS, so both proxies got empty auth headers with no supported
    # way to populate them while the local path worked (issue #407). Optional:
    # left at REPLACE_ME the tabs render their empty state, matching local.
    PAGERDUTY_TOKEN = var.pagerduty_token
    JIRA_TOKEN      = var.jira_token
    JIRA_URL        = var.jira_url
  })

  lifecycle {
    # Preserve manual updates (GitHub tokens etc. set post-apply)
    ignore_changes = [secret_string]
  }
}

resource "aws_secretsmanager_secret" "dora_exporter" {
  name                    = "idp-mvp/dora-exporter"
  description             = "DORA exporter credentials — GITHUB_TOKEN for GitHub API access"
  recovery_window_in_days = var.secret_recovery_window_days
}

resource "aws_secretsmanager_secret_version" "dora_exporter" {
  secret_id = aws_secretsmanager_secret.dora_exporter.id

  secret_string = jsonencode({
    GITHUB_TOKEN = var.dora_github_token
  })
}

resource "aws_secretsmanager_secret" "slack_webhook" {
  name                    = "idp-mvp/slack-webhook"
  description             = "Slack incoming webhook URL for cost alerts"
  recovery_window_in_days = var.secret_recovery_window_days
}

resource "aws_secretsmanager_secret_version" "slack_webhook" {
  secret_id = aws_secretsmanager_secret.slack_webhook.id

  secret_string = jsonencode({
    SLACK_WEBHOOK_URL = var.slack_webhook_url
  })
}

output "backstage_secret_arn" {
  description = "ARN of the Backstage Secrets Manager secret"
  value       = aws_secretsmanager_secret.backstage.arn
}

output "dora_exporter_secret_arn" {
  description = "ARN of the DORA exporter Secrets Manager secret"
  value       = aws_secretsmanager_secret.dora_exporter.arn
}

output "slack_webhook_secret_arn" {
  description = "ARN of the Slack webhook Secrets Manager secret"
  value       = aws_secretsmanager_secret.slack_webhook.arn
}

# ── KAgent (AI/ML platform) secret ────────────────────────────────────────────────
resource "aws_secretsmanager_secret" "kagent" {
  name                    = "idp-mvp/kagent"
  description             = "KAgent AI platform credentials — Anthropic API key, LiteLLM master key"
  recovery_window_in_days = var.secret_recovery_window_days
}

resource "aws_secretsmanager_secret_version" "kagent" {
  secret_id = aws_secretsmanager_secret.kagent.id

  secret_string = jsonencode({
    ANTHROPIC_API_KEY = var.anthropic_api_key
    # LiteLLM's own inbound-auth key (ADR-0008) — reuses this secret rather
    # than a dedicated one, same reuse decision as ai-gateway's Anthropic key
    # sync before it. Read by aws/ml-platform/litellm-external-secret.yaml.
    LITELLM_MASTER_KEY = var.litellm_master_key
  })
}

output "kagent_secret_arn" {
  description = "ARN of the KAgent Secrets Manager secret (idp-mvp/kagent)"
  value       = aws_secretsmanager_secret.kagent.arn
}

# ── Datadog (cluster-wide Agent) secret ───────────────────────────────────────
resource "aws_secretsmanager_secret" "datadog" {
  name                    = "idp-mvp/datadog"
  description             = "Datadog API/App keys for the cluster-wide Datadog Agent"
  recovery_window_in_days = var.secret_recovery_window_days
}

resource "aws_secretsmanager_secret_version" "datadog" {
  secret_id = aws_secretsmanager_secret.datadog.id

  secret_string = jsonencode({
    DD_API_KEY = var.datadog_api_key
    DD_APP_KEY = var.datadog_app_key
  })
}

output "datadog_secret_arn" {
  description = "ARN of the Datadog Secrets Manager secret (idp-mvp/datadog)"
  value       = aws_secretsmanager_secret.datadog.arn
}
