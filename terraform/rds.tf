resource "random_password" "rds" {
  length  = 32
  special = true
}

resource "aws_db_subnet_group" "backstage" {
  name       = "${var.cluster_name}-backstage"
  subnet_ids = module.vpc.private_subnets

  tags = {
    Name = "${var.cluster_name}-backstage-db-subnet-group"
  }
}

resource "aws_security_group" "rds" {
  name        = "${var.cluster_name}-rds"
  description = "Allow PostgreSQL from EKS nodes"
  vpc_id      = module.vpc.vpc_id

  ingress {
    description     = "PostgreSQL from EKS nodes"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [module.eks.node_security_group_id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.cluster_name}-rds-sg"
  }
}

resource "aws_db_instance" "backstage" {
  identifier     = "${var.cluster_name}-backstage"
  engine         = "postgres"
  engine_version = "17"
  instance_class = var.rds_instance_class

  db_name  = var.rds_db_name
  username = var.rds_username
  password = random_password.rds.result

  db_subnet_group_name   = aws_db_subnet_group.backstage.name
  vpc_security_group_ids = [aws_security_group.rds.id]

  multi_az          = var.rds_multi_az
  allocated_storage = var.rds_allocated_storage

  backup_retention_period   = var.rds_backup_retention_days
  storage_encrypted         = true
  skip_final_snapshot       = var.environment == "prod" ? false : true
  final_snapshot_identifier = "${var.cluster_name}-backstage-final"
  deletion_protection       = var.environment == "prod" ? true : false

  tags = {
    Name = "${var.cluster_name}-backstage-db"
  }
}

# ── Langfuse ────────────────────────────────────────────────────────────────────
# Langfuse's Postgres holds the durable, expensive-to-rebuild state: users, API
# keys, projects, datasets and prompt versions. It is deliberately NOT the
# SQLite-on-PVC pattern MLflow uses, because this EKS cluster is intentionally
# torn down between sessions and that state should survive.
#
# ClickHouse (the trace store) stays in-cluster and IS lost on teardown — that
# is the accepted trade-off, since traces are high-volume and time-sensitive
# while the Postgres state is small and irreplaceable.
resource "random_password" "langfuse_rds" {
  length = 32
  # Langfuse composes DATABASE_URL by string-substituting this password into a
  # postgresql:// URI. Characters like @ / : ? # would silently truncate or
  # misparse the URI, so restrict to a URL-safe alphabet rather than escaping.
  special          = true
  override_special = "-_"

  count = var.enable_langfuse ? 1 : 0
}

resource "aws_db_instance" "langfuse" {
  count = var.enable_langfuse ? 1 : 0

  identifier     = "${var.cluster_name}-langfuse"
  engine         = "postgres"
  engine_version = "17"
  instance_class = var.langfuse_rds_instance_class

  db_name  = "langfuse"
  username = "langfuse"
  password = random_password.langfuse_rds[0].result

  # Reuses the Backstage subnet group and security group: both are generic
  # (private subnets; 5432 from the EKS node security group) and a second copy
  # would add cost and drift for no isolation benefit within this single-tenant
  # platform cluster.
  db_subnet_group_name   = aws_db_subnet_group.backstage.name
  vpc_security_group_ids = [aws_security_group.rds.id]

  multi_az          = false
  allocated_storage = 20

  backup_retention_period   = var.rds_backup_retention_days
  storage_encrypted         = true
  skip_final_snapshot       = var.environment == "prod" ? false : true
  final_snapshot_identifier = "${var.cluster_name}-langfuse-final"
  deletion_protection       = var.environment == "prod" ? true : false

  tags = {
    Name = "${var.cluster_name}-langfuse-db"
  }
}

# Read by scripts/bootstrap-ai.sh --aws when building the langfuse-secrets
# Secret, so the password never has to be passed on a command line or read
# back out of Terraform state by hand.
resource "aws_secretsmanager_secret" "langfuse" {
  count = var.enable_langfuse ? 1 : 0

  name                    = "idp-mvp/langfuse"
  description             = "Langfuse self-hosted credentials — Postgres password and app secrets"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "langfuse" {
  count = var.enable_langfuse ? 1 : 0

  secret_id = aws_secretsmanager_secret.langfuse[0].id

  secret_string = jsonencode({
    POSTGRES_PASSWORD = random_password.langfuse_rds[0].result
  })
}

output "langfuse_db_host" {
  description = "RDS endpoint hostname for the Langfuse Postgres database"
  # .address is the bare hostname; .endpoint includes :5432, which the Helm
  # values set separately and would duplicate into host:5432:5432.
  value = one(aws_db_instance.langfuse[*].address)
}

output "langfuse_db_secret_arn" {
  description = "Secrets Manager ARN holding the Langfuse Postgres password"
  value       = one(aws_secretsmanager_secret.langfuse[*].arn)
}

# ── LiteLLM (ADR-0008) ────────────────────────────────────────────────────────
# LiteLLM's virtual keys and per-team budget enforcement — the actual reason
# ADR-0008 chose it over agentgateway's native `provider: bedrock` support —
# do not function without a database: verified against a live deploy, /ui
# login fails outright ("Authentication Error, Not connected to DB!") and
# BerriAI's own docs confirm budgets are silently unenforced at request time
# with no DB connected. Same dedicated-RDS-per-component pattern as Langfuse
# above, not shared with Backstage's instance — this holds proxy metadata
# (keys, spend), not application data, same reasoning as Langfuse's Postgres
# vs its ClickHouse trace store.
resource "random_password" "litellm_rds" {
  length = 32
  # DATABASE_URL below composes this by string interpolation directly (unlike
  # Langfuse, which hands the bare password to its Helm chart to compose).
  # Same URL-safe restriction as langfuse_rds for the same reason: @ / : ? #
  # would misparse the connection string.
  special          = true
  override_special = "-_"

  count = var.enable_litellm ? 1 : 0
}

resource "aws_db_instance" "litellm" {
  count = var.enable_litellm ? 1 : 0

  identifier     = "${var.cluster_name}-litellm"
  engine         = "postgres"
  engine_version = "17"
  instance_class = var.litellm_rds_instance_class

  db_name  = "litellm"
  username = "litellm"
  password = random_password.litellm_rds[0].result

  # Reuses the Backstage subnet group and security group, same reasoning as
  # Langfuse's instance above: both are generic, and a third copy would add
  # cost and drift for no isolation benefit within this single-tenant cluster.
  db_subnet_group_name   = aws_db_subnet_group.backstage.name
  vpc_security_group_ids = [aws_security_group.rds.id]

  multi_az          = false
  allocated_storage = 20

  backup_retention_period   = var.rds_backup_retention_days
  storage_encrypted         = true
  skip_final_snapshot       = var.environment == "prod" ? false : true
  final_snapshot_identifier = "${var.cluster_name}-litellm-final"
  deletion_protection       = var.environment == "prod" ? true : false

  tags = {
    Name = "${var.cluster_name}-litellm-db"
  }
}

# Full connection string, not just the password: Terraform is the one place
# that already knows both the RDS endpoint and the generated password at
# apply time, so composing DATABASE_URL here means aws/ml-platform/litellm-external-secret.yaml
# can pull one ready-to-use property instead of a bootstrap script string-building
# it from two separate lookups (a tf_output for the host, a Secrets Manager read
# for the password) the way Langfuse's Helm values currently do.
resource "aws_secretsmanager_secret" "litellm_db" {
  count = var.enable_litellm ? 1 : 0

  name                    = "idp-mvp/litellm"
  description             = "LiteLLM Postgres connection string (virtual keys, spend tracking) — ADR-0008"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "litellm_db" {
  count = var.enable_litellm ? 1 : 0

  secret_id = aws_secretsmanager_secret.litellm_db[0].id

  secret_string = jsonencode({
    DATABASE_URL = "postgresql://litellm:${random_password.litellm_rds[0].result}@${aws_db_instance.litellm[0].address}:5432/litellm"
  })
}

output "litellm_db_secret_arn" {
  description = "Secrets Manager ARN holding the LiteLLM Postgres connection string"
  value       = one(aws_secretsmanager_secret.litellm_db[*].arn)
}
