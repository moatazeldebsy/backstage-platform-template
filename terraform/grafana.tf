# ── Grafana database ──────────────────────────────────────────────────────────
# Grafana's own state (users, sessions, service-account tokens, UI-created
# dashboards and folders, alert state) lives in its database. On AWS that was
# SQLite inside the pod with persistence disabled, so every Grafana restart
# wiped it — including the service-account token Backstage's Grafana tab uses
# (GRAFANA_TOKEN), which then failed until someone minted a new one by hand.
# A shared Postgres also is what lets Grafana run more than one replica: with
# per-pod SQLite each replica had its own users and sessions, so a login on one
# was unknown to the other.
#
# Same dedicated-instance pattern as Langfuse and LiteLLM in rds.tf (small
# instance, subnet/security group reused). Provisioned dashboards stay in
# ConfigMaps; only Grafana's runtime state moves here.
resource "random_password" "grafana_rds" {
  count = var.enable_grafana_db ? 1 : 0

  length = 32
  # Same URL-safe restriction as the other component databases: the password
  # ends up inside a Postgres connection string.
  special          = true
  override_special = "-_"
}

resource "aws_db_instance" "grafana" {
  count = var.enable_grafana_db ? 1 : 0

  identifier     = "${var.cluster_name}-grafana"
  engine         = "postgres"
  engine_version = "17"
  instance_class = var.grafana_rds_instance_class

  db_name  = "grafana"
  username = "grafana"
  password = random_password.grafana_rds[0].result

  db_subnet_group_name   = aws_db_subnet_group.backstage.name
  vpc_security_group_ids = [aws_security_group.rds.id]

  multi_az          = var.rds_multi_az
  allocated_storage = 20
  storage_type      = "gp3"

  backup_retention_period   = var.rds_backup_retention_days
  storage_encrypted         = true
  copy_tags_to_snapshot     = true
  backup_window             = "03:00-04:00"
  maintenance_window        = "sun:04:30-sun:05:30"
  skip_final_snapshot       = var.environment == "prod" ? false : true
  final_snapshot_identifier = "${var.cluster_name}-grafana-final"
  deletion_protection       = var.environment == "prod" ? true : false

  tags = {
    Name = "${var.cluster_name}-grafana-db"
  }
}

# Keys are Grafana's own env var names, so the ExternalSecret can project the
# whole entry with dataFrom.extract and the chart's envFromSecret picks them up
# with no per-key mapping (aws/observability/grafana-db-external-secret.yaml).
resource "aws_secretsmanager_secret" "grafana_db" {
  count = var.enable_grafana_db ? 1 : 0

  name                    = "idp-mvp/grafana"
  description             = "Grafana Postgres connection (users, sessions, service-account tokens)"
  recovery_window_in_days = var.secret_recovery_window_days
}

resource "aws_secretsmanager_secret_version" "grafana_db" {
  count = var.enable_grafana_db ? 1 : 0

  secret_id = aws_secretsmanager_secret.grafana_db[0].id

  secret_string = jsonencode({
    GF_DATABASE_HOST     = "${aws_db_instance.grafana[0].address}:5432"
    GF_DATABASE_NAME     = "grafana"
    GF_DATABASE_USER     = "grafana"
    GF_DATABASE_PASSWORD = random_password.grafana_rds[0].result
  })
}

# Dedicated ESO role that can read only idp-mvp/grafana, via a SecretStore in
# the monitoring namespace — same least-privilege pattern as datadog_eso_irsa.
module "grafana_eso_irsa" {
  count = var.enable_grafana_db ? 1 : 0

  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.30"

  role_name = "${var.cluster_name}-grafana-eso"

  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["monitoring:grafana-eso-sa"]
    }
  }
}

resource "aws_iam_role_policy" "grafana_eso" {
  count = var.enable_grafana_db ? 1 : 0

  name = "grafana-eso-secrets-read"
  role = module.grafana_eso_irsa[0].iam_role_name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret"
        ]
        Resource = aws_secretsmanager_secret.grafana_db[0].arn
      }
    ]
  })
}

output "grafana_eso_role_arn" {
  description = "IAM role ARN for the Grafana ESO ServiceAccount (IRSA) — reads idp-mvp/grafana. Empty when enable_grafana_db = false."
  value       = one(module.grafana_eso_irsa[*].iam_role_arn)
}
