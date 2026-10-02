# ── Large tier: 75+ teams / 750+ engineers ───────────────────────────────────
# Optimises for blast-radius isolation and throughput. Karpenter required.
# At this scale, consider splitting into a platform cluster (IDP services) and
# one or more workload clusters (team namespaces) — see docs/scaling-runbook.md.
#
# Use: terraform apply -var-file=profiles/large.tfvars
# For multi-cluster: run apply twice with different cluster_name values.

environment = "prod"

# EKS — larger instances reduce scheduling overhead; Karpenter handles burst
node_instance_types     = ["m5.2xlarge"]
node_group_min_size     = 8
node_group_desired_size = 12
node_group_max_size     = 60

# RDS — memory-optimised for Backstage catalog at 1000+ entity scale
rds_instance_class    = "db.r5.xlarge"
rds_multi_az          = true
rds_allocated_storage = 500

# Networking — /16 is the largest CIDR AWS allows on a VPC (/16–/28); the /8 this
# used to set was rejected by CreateVpc. The /20 private subnets it yields (~4k IPs
# each) cover this tier once VPC-CNI prefix delegation is on; beyond that, add a
# secondary CIDR (100.64.0.0/16) for pods rather than widening the primary one.
vpc_cidr = "10.0.0.0/16"

# One NAT gateway per AZ — AZ-level egress resilience (see ADR-0009)
enable_multi_az_nat = true

# Karpenter required at this scale for fast scale-out and cost-efficient bin-packing
enable_karpenter = true

# FinOps — large org; disable overnight scale-down for 24/7 prod availability
budget_monthly_limit_usd = "10000"
enable_cost_optimizer    = false

# Reliability hardening — see variables.tf for each
secret_recovery_window_days      = 7
rds_max_allocated_storage        = 2000
rds_performance_insights_enabled = true
enable_vpc_interface_endpoints   = true

# Audit and network evidence — see variables.tf. Control-plane audit logs and
# VPC flow logs are what an incident review works from.
eks_control_plane_log_types          = ["api", "audit", "authenticator"]
eks_control_plane_log_retention_days = 90
enable_vpc_flow_logs                 = true
