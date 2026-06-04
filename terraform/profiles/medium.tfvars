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

# Karpenter — enables smarter bin-packing and faster node provisioning at this scale
enable_karpenter = true

# FinOps — higher cap; overnight scale-down optional in prod
budget_monthly_limit_usd = "2000"
enable_cost_optimizer    = false
