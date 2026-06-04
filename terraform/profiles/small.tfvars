# ── Small tier: ≤ 25 teams / ≤ 150 engineers ─────────────────────────────────
# Optimises for cost. Single-AZ, no HA, cost optimizer enabled by default.
# Use: terraform apply -var-file=profiles/small.tfvars

environment = "dev"

# EKS
node_instance_types     = ["t3.large"]
node_group_min_size     = 0
node_group_desired_size = 3
node_group_max_size     = 6

# RDS
rds_instance_class    = "db.t3.medium"
rds_multi_az          = false
rds_allocated_storage = 20

# Networking
vpc_cidr = "10.0.0.0/16"

# Karpenter — not needed at this scale; Cluster Autoscaler is sufficient
enable_karpenter = false

# FinOps — tight budget; overnight scale-down highly recommended
budget_monthly_limit_usd       = "200"
enable_cost_optimizer          = true
cost_optimizer_scale_down_cron = "cron(0 20 * * ? *)"
cost_optimizer_scale_up_cron   = "cron(0 7  * * ? *)"
