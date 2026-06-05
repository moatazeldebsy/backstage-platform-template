output "kms_primary_key_arn" {
  description = "ARN of the multi-region KMS CMK in eu-central-1"
  value       = aws_kms_key.primary.arn
}

output "kms_replica_key_arn" {
  description = "ARN of the KMS replica key in us-east-1"
  value       = aws_kms_replica_key.standby.arn
}

output "platform_dns_name" {
  description = "Route 53 DNS name for the IDP platform (idp.<domain_name>)"
  value       = aws_route53_record.primary.fqdn
}

output "health_check_primary_id" {
  description = "Route 53 health check ID for the primary ALB (eu-central-1)"
  value       = aws_route53_health_check.primary.id
}

output "health_check_standby_id" {
  description = "Route 53 health check ID for the standby ALB (us-east-1)"
  value       = aws_route53_health_check.standby.id
}
