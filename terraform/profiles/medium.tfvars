# ── Medium tier: 26–75 teams / 150–750 engineers ─────────────────────────────
# Optimises for availability. Multi-AZ RDS, Karpenter for bin-packing,
# autoscaling group sized for burst capacity.
# Use: terraform apply -var-file=profiles/medium.tfvars

environment = "prod"

# EKS
node_instance_types     = ["m5.xlarge"]
node_group_min_size     = 4
node_group_desired_size = 6
node_group_max_size     = 20

# RDS — multi-AZ for HA; use r5 class for memory-bound Backstage catalog queries
rds_instance_class    = "db.m5.large"
rds_multi_az          = true
rds_allocated_storage = 100

# Networking — same CIDR fits; /16 has 65k addresses, sufficient for 75 team namespaces
vpc_cidr = "10.0.0.0/16"

# One NAT gateway per AZ — without it a single AZ outage cuts all egress
# (image pulls, AWS APIs, GitHub) even though nodes and RDS survive it.
enable_multi_az_nat = true

# Karpenter — enables smarter bin-packing and faster node provisioning at this scale
enable_karpenter = true

# FinOps — higher cap; overnight scale-down optional in prod
budget_monthly_limit_usd = "2000"
enable_cost_optimizer    = false

# Reliability hardening — see variables.tf for each
secret_recovery_window_days      = 7
rds_max_allocated_storage        = 500
rds_performance_insights_enabled = true
enable_vpc_interface_endpoints   = true

# Audit and network evidence — see variables.tf. Control-plane audit logs and
# VPC flow logs are what an incident review works from.
eks_control_plane_log_types          = ["api", "audit", "authenticator"]
eks_control_plane_log_retention_days = 90
enable_vpc_flow_logs                 = true
