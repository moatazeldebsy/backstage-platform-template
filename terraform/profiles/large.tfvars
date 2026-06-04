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

# Networking — expand CIDR to /8 to support multi-cluster peering and 100+ namespaces
vpc_cidr = "10.0.0.0/8"

# Karpenter required at this scale for fast scale-out and cost-efficient bin-packing
enable_karpenter = true

# FinOps — large org; disable overnight scale-down for 24/7 prod availability
budget_monthly_limit_usd = "10000"
enable_cost_optimizer    = false
