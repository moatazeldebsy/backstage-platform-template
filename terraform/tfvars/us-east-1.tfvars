# Standby region — us-east-1 (N. Virginia)
# Usage: terraform workspace new us-east-1
#        terraform apply -var-file=tfvars/us-east-1.tfvars

aws_region         = "us-east-1"
secondary_region   = "eu-central-1"
is_primary_region  = false
cluster_name       = "idp-us-east-1"
vpc_cidr           = "10.1.0.0/16"   # Non-overlapping — required for Transit Gateway
environment        = "prod"

# Node groups — warm standby (scaled down until failover)
node_instance_types     = ["m6g.large"]
node_group_min_size     = 1
node_group_max_size     = 10
node_group_desired_size = 2

# HA NAT gateways across all 3 AZs
enable_multi_az_nat = true

# RDS — standby sizing (Aurora Global read replica, not standalone RDS)
rds_instance_class    = "db.t4g.medium"
rds_multi_az          = true
rds_allocated_storage = 50

# Karpenter — also enabled in standby for consistent node provisioning at failover
enable_karpenter = true

# Budget
budget_monthly_limit_usd = "300"
budget_alert_email       = "REPLACE_ME"
