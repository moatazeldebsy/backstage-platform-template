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

output "aurora_global_cluster_id" {
  description = "Aurora Global cluster identifier"
  value       = aws_rds_global_cluster.backstage.id
}

output "aurora_primary_writer_endpoint" {
  description = "Aurora writer endpoint in eu-central-1 — use this as POSTGRES_HOST in Backstage primary"
  value       = aws_rds_cluster.primary.endpoint
}

output "aurora_primary_reader_endpoint" {
  description = "Aurora reader endpoint in eu-central-1 (load-balanced across all read replicas)"
  value       = aws_rds_cluster.primary.reader_endpoint
}

output "aurora_replica_reader_endpoint" {
  description = "Aurora reader endpoint in us-east-1 — use this as POSTGRES_HOST when running in standby"
  value       = aws_rds_cluster.replica.reader_endpoint
}

output "aurora_failover_command" {
  description = "AWS CLI command to promote the us-east-1 replica to primary writer during failover"
  value       = "aws rds failover-global-cluster --global-cluster-identifier ${aws_rds_global_cluster.backstage.id} --target-db-cluster-identifier ${aws_rds_cluster.replica.cluster_identifier}"
}

output "s3_replication_role_arn" {
  description = "IAM role ARN for S3 CRR — set as metadata.annotations[idp.platform/s3-replication-role-arn] on S3Bucket claims"
  value       = aws_iam_role.s3_replication.arn
}

output "global_accelerator_ips" {
  description = "Static anycast IP addresses of the Global Accelerator — use these for IP allowlist configurations"
  value       = aws_globalaccelerator_accelerator.platform.ip_sets[*].ip_addresses
}

output "global_accelerator_dns" {
  description = "DNS name of the Global Accelerator endpoint"
  value       = aws_globalaccelerator_accelerator.platform.dns_name
}

output "cloudfront_domain_name" {
  description = "CloudFront distribution domain name (before custom domain DNS is set)"
  value       = aws_cloudfront_distribution.platform.domain_name
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID (needed for cache invalidation)"
  value       = aws_cloudfront_distribution.platform.id
}

output "waf_web_acl_arn" {
  description = "WAF Web ACL ARN — attach to regional ALBs via aws_wafv2_web_acl_association"
  value       = aws_wafv2_web_acl.platform.arn
}
