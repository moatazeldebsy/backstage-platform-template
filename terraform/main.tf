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

  backend "s3" {
    bucket               = "idp-mvp-terraform-state-YOUR_AWS_ACCOUNT_ID"
    key                  = "terraform.tfstate"
    workspace_key_prefix = "platform"  # state path: platform/<workspace>/terraform.tfstate
    region               = "us-east-1" # state bucket always in us-east-1
    dynamodb_table       = "idp-mvp-terraform-locks"
    encrypt              = true
  }
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
