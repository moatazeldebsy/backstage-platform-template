# Primary region — eu-central-1 (Frankfurt)
# Usage:
#   terraform init          # required once after adding alekc/kubectl provider (V2)
#   terraform workspace new eu-central-1
#   terraform apply -var-file=tfvars/eu-central-1.tfvars

aws_region         = "eu-central-1"
secondary_region   = "us-east-1"
is_primary_region  = true
cluster_name       = "idp-eu-central-1"
vpc_cidr           = "10.0.0.0/16"
environment        = "prod"

# Node groups — production sizing
node_instance_types     = ["m6g.large"]    # Graviton2, cost-optimized
node_group_min_size     = 2
node_group_max_size     = 10
node_group_desired_size = 3

# HA NAT gateways across all 3 AZs (required for production)
enable_multi_az_nat = true

# RDS — production sizing
rds_instance_class    = "db.t4g.medium"
rds_multi_az          = true
rds_allocated_storage = 50

# Karpenter — replaces managed node groups for team service workloads
enable_karpenter = true

# Budget
budget_monthly_limit_usd = "500"
budget_alert_email       = "REPLACE_ME"
