# Aurora Global Database — primary writer in eu-central-1, read replica in us-east-1.
#
# RPO: < 1 second (physical replication lag)
# RTO: < 1 minute (managed failover via aws rds failover-global-cluster)
#
# Migration from standalone RDS (terraform/rds.tf):
#   1. Create a snapshot of the existing RDS instance.
#   2. Restore the snapshot into the primary Aurora cluster (aurora_restore_to_cluster below).
#   3. Apply this file — Terraform creates the global cluster and wires the replica.
#   4. Update backstage secret (POSTGRES_HOST) to point to the writer endpoint.
#   5. Remove the old aws_db_instance.backstage resource from terraform/rds.tf.
#
# Failover (standby promotion):
#   aws rds failover-global-cluster \
#     --global-cluster-identifier idp-mvp-global \
#     --target-db-cluster-identifier idp-us-east-1-backstage

resource "random_password" "aurora" {
  length  = 32
  special = false # Aurora password cannot contain / @ " space
}

# Global cluster shell — no engine or storage, just the logical global entity
resource "aws_rds_global_cluster" "backstage" {
  global_cluster_identifier = "idp-mvp-global"
  engine                    = "aurora-postgresql"
  engine_version            = "16.4"
  database_name             = var.rds_db_name
  storage_encrypted         = true
}

# ── Primary cluster (eu-central-1) ────────────────────────────────────────────

resource "aws_rds_cluster" "primary" {
  cluster_identifier        = "idp-eu-central-1-backstage"
  engine                    = aws_rds_global_cluster.backstage.engine
  engine_version            = aws_rds_global_cluster.backstage.engine_version
  global_cluster_identifier = aws_rds_global_cluster.backstage.id
  database_name             = var.rds_db_name
  master_username           = var.rds_username
  master_password           = random_password.aurora.result

  db_subnet_group_name   = aws_db_subnet_group.aurora_primary.name
  vpc_security_group_ids = [aws_security_group.aurora_primary.id]

  backup_retention_period   = 7
  skip_final_snapshot       = var.environment == "prod" ? false : true
  final_snapshot_identifier = "idp-eu-central-1-backstage-final"
  deletion_protection       = var.environment == "prod" ? true : false

  enabled_cloudwatch_logs_exports = ["postgresql"]

  tags = {
    Name = "idp-eu-central-1-backstage"
    Role = "primary-writer"
  }
}

resource "aws_rds_cluster_instance" "primary" {
  count = 2 # writer + 1 reader within eu-central-1 for local HA

  identifier         = "idp-eu-central-1-backstage-${count.index}"
  cluster_identifier = aws_rds_cluster.primary.id
  instance_class     = var.rds_instance_class
  engine             = aws_rds_cluster.primary.engine
  engine_version     = aws_rds_cluster.primary.engine_version

  performance_insights_enabled = true
}

resource "aws_db_subnet_group" "aurora_primary" {
  name       = "idp-eu-central-1-aurora"
  subnet_ids = var.primary_private_subnet_ids

  tags = {
    Name = "idp-eu-central-1-aurora-subnet-group"
  }
}

resource "aws_security_group" "aurora_primary" {
  name        = "idp-eu-central-1-aurora"
  description = "Allow PostgreSQL from EKS nodes in eu-central-1"
  vpc_id      = var.primary_vpc_id

  ingress {
    description = "Aurora PostgreSQL from EKS"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [var.primary_vpc_cidr]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "idp-eu-central-1-aurora-sg" }
}

# ── Replica cluster (us-east-1) ────────────────────────────────────────────────

resource "aws_rds_cluster" "replica" {
  provider = aws.standby

  cluster_identifier        = "idp-us-east-1-backstage"
  engine                    = aws_rds_global_cluster.backstage.engine
  engine_version            = aws_rds_global_cluster.backstage.engine_version
  global_cluster_identifier = aws_rds_global_cluster.backstage.id

  db_subnet_group_name   = aws_db_subnet_group.aurora_replica.name
  vpc_security_group_ids = [aws_security_group.aurora_replica.id]

  # Replica clusters inherit credentials from the global cluster — no master_username/password
  skip_final_snapshot       = var.environment == "prod" ? false : true
  final_snapshot_identifier = "idp-us-east-1-backstage-final"

  tags = {
    Name = "idp-us-east-1-backstage"
    Role = "replica-reader"
  }

  depends_on = [aws_rds_cluster_instance.primary]
}

resource "aws_rds_cluster_instance" "replica" {
  provider = aws.standby

  identifier         = "idp-us-east-1-backstage-0"
  cluster_identifier = aws_rds_cluster.replica.id
  instance_class     = var.rds_instance_class
  engine             = aws_rds_cluster.replica.engine
  engine_version     = aws_rds_cluster.replica.engine_version
}

resource "aws_db_subnet_group" "aurora_replica" {
  provider = aws.standby

  name       = "idp-us-east-1-aurora"
  subnet_ids = var.standby_private_subnet_ids

  tags = {
    Name = "idp-us-east-1-aurora-subnet-group"
  }
}

resource "aws_security_group" "aurora_replica" {
  provider = aws.standby

  name        = "idp-us-east-1-aurora"
  description = "Allow PostgreSQL from EKS nodes in us-east-1"
  vpc_id      = var.standby_vpc_id

  ingress {
    description = "Aurora PostgreSQL from EKS"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [var.standby_vpc_cidr]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "idp-us-east-1-aurora-sg" }
}
