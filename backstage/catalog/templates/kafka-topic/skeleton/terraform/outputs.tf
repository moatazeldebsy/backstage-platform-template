output "topic_name" {
  description = "Created Kafka topic name"
  value       = kafka_topic.this.name
}

output "topic_partitions" {
  description = "Number of partitions"
  value       = kafka_topic.this.partitions
}

output "msk_bootstrap_brokers" {
  description = "MSK bootstrap broker endpoints (SASL/IAM)"
  value       = data.aws_msk_cluster.this.bootstrap_brokers_sasl_iam
  sensitive   = true
}

output "schema_registry_arn" {
  description = "ARN of the Glue schema (empty if schema registry not enabled)"
  value       = var.schema_registry_subject != "" ? aws_glue_schema.this[0].arn : ""
}
