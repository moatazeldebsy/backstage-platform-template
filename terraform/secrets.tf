resource "random_password" "backstage_session" {
  length  = 64
  special = false
}

resource "aws_secretsmanager_secret" "backstage" {
  name                    = "idp-mvp/backstage"
  description             = "Backstage IDP platform credentials"
  recovery_window_in_days = 0

  dynamic "replica" {
    for_each = var.is_primary_region ? [var.secondary_region] : []
    content {
      region = replica.value
    }
  }
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
    # V2: Aurora Global endpoints — POSTGRES_HOST_READER is used by standby Backstage.
    # After Aurora Global failover, us-east-1 cluster endpoint becomes the writer.
    # bootstrap.sh (or the post-failover runbook) updates POSTGRES_HOST to the new writer.
    POSTGRES_HOST_WRITER = "REPLACE_ME_AFTER_AURORA_GLOBAL_APPLY"
    POSTGRES_HOST_READER = "REPLACE_ME_AFTER_AURORA_GLOBAL_APPLY"
  })

  lifecycle {
    # Preserve manual updates (GitHub tokens, Aurora endpoints set post-apply)
    ignore_changes = [secret_string]
  }
}

resource "aws_secretsmanager_secret" "dora_exporter" {
  name                    = "idp-mvp/dora-exporter"
  description             = "DORA exporter credentials — GITHUB_TOKEN for GitHub API access"
  recovery_window_in_days = 0

  dynamic "replica" {
    for_each = var.is_primary_region ? [var.secondary_region] : []
    content {
      region = replica.value
    }
  }
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
  recovery_window_in_days = 0
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
  description             = "KAgent AI platform credentials — Anthropic API key"
  recovery_window_in_days = 0

  dynamic "replica" {
    for_each = var.is_primary_region ? [var.secondary_region] : []
    content {
      region = replica.value
    }
  }
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

# ── Datadog (cluster-wide Agent) secret ───────────────────────────────────────
resource "aws_secretsmanager_secret" "datadog" {
  name                    = "idp-mvp/datadog"
  description             = "Datadog API/App keys for the cluster-wide Datadog Agent"
  recovery_window_in_days = 0

  dynamic "replica" {
    for_each = var.is_primary_region ? [var.secondary_region] : []
    content {
      region = replica.value
    }
  }
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

# ── ArgoCD cluster registration secrets ───────────────────────────────────────
# Populated by the post-apply script (scripts/register-argocd-cluster.sh) after
# the EKS cluster is up. The ExternalSecrets in aws/argocd/cluster-secrets/ read
# from these to create the ArgoCD cluster secret objects in the hub cluster.
resource "aws_secretsmanager_secret" "argocd_cluster" {
  name                    = "idp-mvp/argocd/cluster-${var.aws_region}"
  description             = "ArgoCD cluster registration credentials for ${var.aws_region} EKS cluster"
  recovery_window_in_days = 0

  dynamic "replica" {
    for_each = var.is_primary_region ? [var.secondary_region] : []
    content {
      region = replica.value
    }
  }
}

resource "aws_secretsmanager_secret_version" "argocd_cluster" {
  secret_id = aws_secretsmanager_secret.argocd_cluster.id

  secret_string = jsonencode({
    server      = module.eks.cluster_endpoint
    caData      = module.eks.cluster_certificate_authority_data
    bearerToken = "REPLACE_ME_RUN_register-argocd-cluster.sh"
  })

  lifecycle {
    # bearerToken is set by register-argocd-cluster.sh post-apply — don't overwrite on re-apply
    ignore_changes = [secret_string]
  }
}

# ── Backstage multi-cluster Kubernetes plugin secrets ─────────────────────────
# Populated by register-argocd-cluster.sh (same SA token is reused for Backstage).
# Referenced by app-config.aws.yaml kubernetes.clusterLocatorMethods.
resource "aws_secretsmanager_secret" "backstage_k8s" {
  name                    = "idp-mvp/backstage/k8s-${var.aws_region}"
  description             = "Backstage Kubernetes plugin credentials for ${var.aws_region} EKS cluster"
  recovery_window_in_days = 0

  dynamic "replica" {
    for_each = var.is_primary_region ? [var.secondary_region] : []
    content {
      region = replica.value
    }
  }
}

resource "aws_secretsmanager_secret_version" "backstage_k8s" {
  secret_id = aws_secretsmanager_secret.backstage_k8s.id

  secret_string = jsonencode({
    url    = module.eks.cluster_endpoint
    caData = module.eks.cluster_certificate_authority_data
    token  = "REPLACE_ME_RUN_register-argocd-cluster.sh"
  })

  lifecycle {
    ignore_changes = [secret_string]
  }
}
