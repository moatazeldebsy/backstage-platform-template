variable "instance_name" {
  description = "Unique RDS instance identifier"
  type        = string
  default     = "${{ values.instanceName }}"
}

variable "owner_service" {
  description = "Owning service — credentials are injected into this service's namespace"
  type        = string
  default     = "${{ values.ownerService }}"
}

variable "db_name" {
  description = "PostgreSQL database name"
  type        = string
  default     = "${{ values.dbName }}"
}

variable "db_username" {
  description = "Master database username"
  type        = string
  default     = "${{ values.dbUsername }}"
}

variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "${{ values.awsRegion }}"
}

variable "postgres_version" {
  description = "PostgreSQL major version"
  type        = string
  default     = "${{ values.postgresVersion }}"
}

variable "instance_class" {
  description = "RDS instance class"
  type        = string
  default     = "${{ values.instanceClass }}"
}

variable "storage_gb" {
  description = "Allocated storage in GB"
  type        = number
  default     = ${{ values.storageGb }}
}

variable "multi_az" {
  description = "Enable Multi-AZ deployment for high availability"
  type        = bool
  default     = ${{ values.multiAz }}
}

variable "backup_retention_days" {
  description = "Number of days to retain automated backups"
  type        = number
  default     = ${{ values.backupRetentionDays }}
}

variable "enable_iam_auth" {
  description = "Enable IAM database authentication"
  type        = bool
  default     = ${{ values.enableIamAuth }}
}
