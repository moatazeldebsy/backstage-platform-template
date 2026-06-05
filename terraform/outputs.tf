output "cluster_name" {
  description = "EKS cluster name"
  value       = module.eks.cluster_name
}

output "cluster_endpoint" {
  description = "EKS cluster endpoint"
  value       = module.eks.cluster_endpoint
}

output "cluster_arn" {
  description = "EKS cluster ARN"
  value       = module.eks.cluster_arn
}

output "configure_kubectl" {
  description = "Configure kubectl command"
  value       = "aws eks update-kubeconfig --region ${var.aws_region} --name ${module.eks.cluster_name}"
}

output "vpc_id" {
  description = "VPC ID"
  value       = module.vpc.vpc_id
}

output "rds_endpoint" {
  description = "RDS PostgreSQL endpoint for Backstage"
  value       = aws_db_instance.backstage.address
}

output "rds_port" {
  description = "RDS PostgreSQL port"
  value       = aws_db_instance.backstage.port
}

output "crossplane_aws_role_arn" {
  description = "IAM role ARN assumed by Crossplane AWS providers via IRSA. Used as the eks.amazonaws.com/role-arn annotation on the provider-* ServiceAccounts in crossplane-system."
  value       = aws_iam_role.crossplane_aws.arn
}

output "secondary_region" {
  description = "Secondary (standby) AWS region configured for this workspace"
  value       = var.secondary_region
}

output "is_primary_region" {
  description = "Whether this workspace is the primary region (eu-central-1)"
  value       = var.is_primary_region
}

output "configure_kubectl_cmd" {
  description = "Command to add this cluster to kubeconfig"
  value       = "aws eks update-kubeconfig --region ${var.aws_region} --name ${module.eks.cluster_name}"
}

output "argocd_cluster_secret_name" {
  description = "Secrets Manager secret name to populate for ArgoCD hub-spoke cluster registration"
  value       = "idp-mvp/argocd/cluster-${var.aws_region}"
}
