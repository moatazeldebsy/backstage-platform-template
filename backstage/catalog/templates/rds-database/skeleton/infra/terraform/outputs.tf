output "db_instance_identifier" {
  description = "RDS instance identifier"
  value       = aws_db_instance.this.identifier
}

output "db_instance_endpoint" {
  description = "RDS instance connection endpoint"
  value       = aws_db_instance.this.endpoint
}

output "db_instance_address" {
  description = "RDS instance hostname"
  value       = aws_db_instance.this.address
}

output "db_instance_port" {
  description = "RDS instance port"
  value       = aws_db_instance.this.port
}

output "db_secret_arn" {
  description = "ARN of the Secrets Manager secret holding DB credentials"
  value       = aws_secretsmanager_secret.db.arn
}

output "db_secret_name" {
  description = "Name of the Secrets Manager secret"
  value       = aws_secretsmanager_secret.db.name
}

output "iam_auth_policy_arn" {
  description = "ARN of the IAM policy enabling IAM authentication (empty if IAM auth disabled)"
  value       = var.enable_iam_auth ? aws_iam_policy.rds_iam_auth[0].arn : ""
}
