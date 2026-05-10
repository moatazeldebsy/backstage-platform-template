variable "topic_name" {
  description = "Kafka topic name"
  type        = string
  default     = "${{ values.topicName }}"
}

variable "owner_service" {
  description = "Owning service — ACLs are created for this principal"
  type        = string
  default     = "${{ values.ownerService }}"
}

variable "msk_cluster" {
  description = "MSK cluster name"
  type        = string
  default     = "${{ values.mskCluster }}"
}

variable "partitions" {
  description = "Number of topic partitions"
  type        = number
  default     = ${{ values.partitions }}
}

variable "replication_factor" {
  description = "Topic replication factor"
  type        = number
  default     = ${{ values.replicationFactor }}
}

variable "retention_hours" {
  description = "Message retention period in hours"
  type        = number
  default     = ${{ values.retentionHours }}
}

variable "cleanup_policy" {
  description = "Kafka cleanup policy (delete, compact, or compact,delete)"
  type        = string
  default     = "${{ values.cleanupPolicy }}"
}

variable "schema_registry_subject" {
  description = "AWS Glue Schema Registry subject name (empty string disables schema registry)"
  type        = string
  default     = "${{ values.schemaRegistrySubject }}"
}
