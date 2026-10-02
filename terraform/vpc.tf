data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  azs             = slice(data.aws_availability_zones.available.names, 0, 3)
  private_subnets = [for i, az in local.azs : cidrsubnet(var.vpc_cidr, 4, i)]
  public_subnets  = [for i, az in local.azs : cidrsubnet(var.vpc_cidr, 4, i + 4)]
}

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"

  name = "${var.cluster_name}-vpc"
  cidr = var.vpc_cidr

  azs             = local.azs
  private_subnets = local.private_subnets
  public_subnets  = local.public_subnets

  enable_nat_gateway = true

  # VPC flow logs (accepted + rejected) to CloudWatch, on medium/large. Without
  # them there is no network evidence to work from after an incident.
  enable_flow_log                                 = var.enable_vpc_flow_logs
  create_flow_log_cloudwatch_log_group            = var.enable_vpc_flow_logs
  create_flow_log_cloudwatch_iam_role             = var.enable_vpc_flow_logs
  flow_log_cloudwatch_log_group_retention_in_days = 30
  flow_log_max_aggregation_interval               = 600
  single_nat_gateway                              = !var.enable_multi_az_nat # false in production → one NAT per AZ
  one_nat_gateway_per_az                          = var.enable_multi_az_nat
  enable_dns_hostnames                            = true
  enable_dns_support                              = true

  # Required for EKS load balancer controller
  public_subnet_tags = {
    "kubernetes.io/role/elb"                    = 1
    "kubernetes.io/cluster/${var.cluster_name}" = "shared"
  }

  private_subnet_tags = {
    "kubernetes.io/role/internal-elb"           = 1
    "kubernetes.io/cluster/${var.cluster_name}" = "shared"
  }
}

# ── VPC endpoints ─────────────────────────────────────────────────────────────
# Keeps the traffic the platform cannot run without off the NAT gateways:
#   - S3 (gateway, free): ECR image layers are served from S3, plus TechDocs,
#     Loki/Tempo chunks, Velero backups and Terraform state.
#   - ECR api/dkr, STS, Secrets Manager, CloudWatch Logs (interface, opt-in):
#     image pulls, IRSA token exchange (every pod with an AWS role), External
#     Secrets sync and log shipping.
# With these, losing a NAT gateway (or its AZ on profiles/small, which has
# only one) no longer stops pods from pulling images or reading their secrets.
# It also stops NAT data-processing charges ($0.045/GB) on what is by far the
# largest egress: image layers.
module "vpc_endpoints" {
  source  = "terraform-aws-modules/vpc/aws//modules/vpc-endpoints"
  version = "~> 5.0"

  vpc_id = module.vpc.vpc_id

  create_security_group      = var.enable_vpc_interface_endpoints
  security_group_name_prefix = "${var.cluster_name}-vpce-"
  security_group_description = "HTTPS from inside the VPC to interface endpoints"
  security_group_rules = {
    ingress_https = {
      description = "HTTPS from the VPC"
      cidr_blocks = [module.vpc.vpc_cidr_block]
    }
  }

  endpoints = merge(
    {
      s3 = {
        service         = "s3"
        service_type    = "Gateway"
        route_table_ids = module.vpc.private_route_table_ids
        tags            = { Name = "${var.cluster_name}-s3" }
      }
    },
    var.enable_vpc_interface_endpoints ? {
      for svc in ["ecr.api", "ecr.dkr", "sts", "secretsmanager", "logs"] :
      replace(svc, ".", "_") => {
        service             = svc
        private_dns_enabled = true
        subnet_ids          = module.vpc.private_subnets
        tags                = { Name = "${var.cluster_name}-${svc}" }
      }
    } : {}
  )
}
