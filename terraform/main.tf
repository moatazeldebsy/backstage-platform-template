terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.23"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.11"
    }
    # alekc/kubectl — required for Karpenter EC2NodeClass and NodePool manifests.
    # Run `terraform init` after pulling this change to update .terraform.lock.hcl.
    kubectl = {
      source  = "alekc/kubectl"
      version = "~> 2.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.5"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
  }

  # Partial backend: every value is supplied at init time from terraform/backend.hcl,
  # which scripts/setup.sh generates after creating the bucket and lock table.
  #
  # These used to be hardcoded to the template maintainer's own bucket and account
  # id. That is not a YOUR_* placeholder, so scripts/placeholders.conf never
  # rewrote it, and anyone else cloning this template hit AccessDenied on their
  # very first `terraform init` -- about thirty seconds into a forty-minute script.
  # Terraform also cannot create its own backend, so the bucket has to exist before
  # init: see ensure_tf_state_backend() in scripts/lib.sh.
  backend "s3" {}
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "idp-mvp"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

# Secondary region provider — used for cross-region data lookups and replication.
# Resources that target the secondary region must set provider = aws.secondary.
provider "aws" {
  alias  = "secondary"
  region = var.secondary_region

  default_tags {
    tags = {
      Project     = "idp-mvp"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

provider "kubernetes" {
  host                   = module.eks.cluster_endpoint
  cluster_ca_certificate = base64decode(module.eks.cluster_certificate_authority_data)

  exec {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "aws"
    args        = ["eks", "get-token", "--cluster-name", module.eks.cluster_name]
  }
}

provider "helm" {
  kubernetes {
    host                   = module.eks.cluster_endpoint
    cluster_ca_certificate = base64decode(module.eks.cluster_certificate_authority_data)

    exec {
      api_version = "client.authentication.k8s.io/v1beta1"
      command     = "aws"
      args        = ["eks", "get-token", "--cluster-name", module.eks.cluster_name]
    }
  }
}

provider "kubectl" {
  host                   = module.eks.cluster_endpoint
  cluster_ca_certificate = base64decode(module.eks.cluster_certificate_authority_data)
  load_config_file       = false

  exec {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "aws"
    args        = ["eks", "get-token", "--cluster-name", module.eks.cluster_name]
  }
}
