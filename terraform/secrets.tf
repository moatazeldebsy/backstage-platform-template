resource "aws_secretsmanager_secret" "backstage" {
  name                    = "idp-mvp/backstage"
  description             = "Backstage IDP platform credentials"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "backstage" {
  secret_id = aws_secretsmanager_secret.backstage.id

  secret_string = jsonencode({
    POSTGRES_HOST             = aws_db_instance.backstage.address
    POSTGRES_PORT             = "5432"
    POSTGRES_USER             = var.rds_username
    POSTGRES_PASSWORD         = random_password.rds.result
    GITHUB_TOKEN              = "REPLACE_ME"
    AUTH_GITHUB_CLIENT_ID     = "REPLACE_ME" # GitHub OAuth App client ID
    AUTH_GITHUB_CLIENT_SECRET = "REPLACE_ME" # GitHub OAuth App client secret
    K8S_CLUSTER_URL           = module.eks.cluster_endpoint
    K8S_SERVICE_ACCOUNT_TOKEN = "REPLACE_ME"
    TECHDOCS_S3_BUCKET_NAME   = aws_s3_bucket.techdocs.id
    AWS_REGION                = var.aws_region
  })
}

resource "aws_secretsmanager_secret" "dora_exporter" {
  name                    = "idp-mvp/dora-exporter"
  description             = "DORA exporter credentials — GITHUB_TOKEN for GitHub API access"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "dora_exporter" {
  secret_id = aws_secretsmanager_secret.dora_exporter.id

  secret_string = jsonencode({
    GITHUB_TOKEN = "REPLACE_ME" # GitHub PAT with repo:read scope
  })
}

resource "aws_secretsmanager_secret" "slack_webhook" {
  name                    = "idp-mvp/slack-webhook"
  description             = "Slack incoming webhook URL for cost alerts"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "slack_webhook" {
  secret_id = aws_secretsmanager_secret.slack_webhook.id

  secret_string = jsonencode({
    SLACK_WEBHOOK_URL = "REPLACE_ME" # Slack incoming webhook URL
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
  description             = "KAgent AI platform credentials — Anthropic API key"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "kagent" {
  secret_id = aws_secretsmanager_secret.kagent.id

  secret_string = jsonencode({
    ANTHROPIC_API_KEY = var.anthropic_api_key
  })
}

output "kagent_secret_arn" {
  description = "ARN of the KAgent Secrets Manager secret (idp-mvp/kagent)"
  value       = aws_secretsmanager_secret.kagent.arn
}
