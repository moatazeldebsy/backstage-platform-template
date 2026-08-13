# Global Terraform module — cross-region resources with no dependency on per-cluster state.
# Apply this ONCE after both regional clusters are up:
#   terraform init
#   terraform apply -var-file=terraform.tfvars
#
# State: separate from per-region state (key: platform/global/terraform.tfstate)

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Partial backend, sharing the bucket and lock table that
  # ensure_tf_state_backend() (scripts/lib.sh) creates for the root module.
  # bootstrap-multiregion.sh supplies terraform/backend.hcl plus an overriding
  # key= so the global module keeps its own state path:
  #   terraform init -backend-config=../backend.hcl \
  #                  -backend-config="key=platform/global/terraform.tfstate"
  #
  # The bucket name here used to be hardcoded to a different shape than the one
  # anything actually creates, so this module could never have initialised.
  backend "s3" {}
}

# Default provider targets the primary region (eu-central-1)
provider "aws" {
  region = var.primary_region

  default_tags {
    tags = {
      Project   = "idp-mvp"
      ManagedBy = "terraform"
      Scope     = "global"
    }
  }
}

# Standby region provider — used for ECR replication target + KMS replica key
provider "aws" {
  alias  = "standby"
  region = var.standby_region

  default_tags {
    tags = {
      Project   = "idp-mvp"
      ManagedBy = "terraform"
      Scope     = "global"
    }
  }
}

# us-east-1 provider for Route 53 — ACM certificates for CloudFront must be in us-east-1
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = {
      Project   = "idp-mvp"
      ManagedBy = "terraform"
      Scope     = "global"
    }
  }
}

data "aws_caller_identity" "current" {}
