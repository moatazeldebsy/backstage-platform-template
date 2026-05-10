terraform {
  required_version = ">= 1.5"

  required_providers {
    kafka = {
      source  = "Mongey/kafka"
      version = "~> 0.7"
    }
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Uncomment and configure for remote state
  # backend "s3" {
  #   bucket         = "idp-mvp-terraform-state-<ACCOUNT_ID>"
  #   key            = "infra/kafka-topics/${{ values.topicName | replace('.', '-') }}/terraform.tfstate"
  #   region         = "us-east-1"
  #   dynamodb_table = "idp-mvp-terraform-locks"
  #   encrypt        = true
  # }
}

provider "aws" {
  region = "us-east-1"
}

# MSK cluster data source — resolves bootstrap brokers by cluster name
data "aws_msk_cluster" "this" {
  cluster_name = var.msk_cluster
}

provider "kafka" {
  bootstrap_servers = split(",", data.aws_msk_cluster.this.bootstrap_brokers_sasl_iam)
}

# ---------------------------------------------------------------------------
# Kafka topic
# ---------------------------------------------------------------------------
resource "kafka_topic" "this" {
  name               = var.topic_name
  replication_factor = var.replication_factor
  partitions         = var.partitions

  config = {
    "retention.ms"    = tostring(var.retention_hours * 3600 * 1000)
    "cleanup.policy"  = var.cleanup_policy
    "min.insync.replicas" = tostring(max(1, var.replication_factor - 1))
  }
}

# ---------------------------------------------------------------------------
# ACLs — producer access for owning service
# ---------------------------------------------------------------------------
resource "kafka_acl" "producer" {
  resource_name                = var.topic_name
  resource_type                = "Topic"
  acl_principal                = "User:${var.owner_service}"
  acl_host                     = "*"
  acl_operation                = "Write"
  acl_permission_type          = "Allow"
  resource_pattern_type_filter = "Literal"

  depends_on = [kafka_topic.this]
}

resource "kafka_acl" "producer_describe" {
  resource_name                = var.topic_name
  resource_type                = "Topic"
  acl_principal                = "User:${var.owner_service}"
  acl_host                     = "*"
  acl_operation                = "Describe"
  acl_permission_type          = "Allow"
  resource_pattern_type_filter = "Literal"

  depends_on = [kafka_topic.this]
}

# ---------------------------------------------------------------------------
# ACLs — consumer access for owning service
# ---------------------------------------------------------------------------
resource "kafka_acl" "consumer" {
  resource_name                = var.topic_name
  resource_type                = "Topic"
  acl_principal                = "User:${var.owner_service}"
  acl_host                     = "*"
  acl_operation                = "Read"
  acl_permission_type          = "Allow"
  resource_pattern_type_filter = "Literal"

  depends_on = [kafka_topic.this]
}

resource "kafka_acl" "consumer_group" {
  resource_name                = "${var.owner_service}-*"
  resource_type                = "Group"
  acl_principal                = "User:${var.owner_service}"
  acl_host                     = "*"
  acl_operation                = "Read"
  acl_permission_type          = "Allow"
  resource_pattern_type_filter = "Prefixed"

  depends_on = [kafka_topic.this]
}

# ---------------------------------------------------------------------------
# AWS Glue Schema Registry subject (optional)
# ---------------------------------------------------------------------------
data "aws_glue_registry" "this" {
  count         = var.schema_registry_subject != "" ? 1 : 0
  registry_name = "default-registry"
}

resource "aws_glue_schema" "this" {
  count          = var.schema_registry_subject != "" ? 1 : 0
  schema_name    = var.schema_registry_subject
  registry_arn   = data.aws_glue_registry.this[0].arn
  data_format    = "AVRO"
  compatibility  = "BACKWARD"
  schema_definition = jsonencode({
    type      = "record"
    name      = replace(var.schema_registry_subject, "-", "_")
    namespace = "com.idp.${var.owner_service}"
    fields    = []
  })

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# Locals
# ---------------------------------------------------------------------------
locals {
  common_tags = {
    "managed-by"    = "idp-backstage"
    "topic-name"    = var.topic_name
    "owner-service" = var.owner_service
    "msk-cluster"   = var.msk_cluster
  }
}
