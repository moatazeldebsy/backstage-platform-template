terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.12"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.27"
    }
  }

  # Uncomment and configure for remote state
  # backend "s3" {
  #   bucket         = "idp-mvp-terraform-state-<ACCOUNT_ID>"
  #   key            = "infra/eks-clusters/${{ values.clusterName }}/terraform.tfstate"
  #   region         = "us-east-1"
  #   dynamodb_table = "idp-mvp-terraform-locks"
  #   encrypt        = true
  # }
}

provider "aws" {
  region = var.aws_region
}

data "aws_caller_identity" "current" {}

data "aws_availability_zones" "available" {
  state = "available"
}

# ---------------------------------------------------------------------------
# VPC — look up existing VPC by Name tag or create one
# ---------------------------------------------------------------------------
data "aws_vpc" "cluster" {
  tags = {
    Name = "${var.cluster_name}-vpc"
  }
}

data "aws_subnets" "private" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.cluster.id]
  }

  tags = {
    Tier = "private"
  }
}

# ---------------------------------------------------------------------------
# EKS cluster — terraform-aws-modules/eks
# ---------------------------------------------------------------------------
module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.0"

  cluster_name    = var.cluster_name
  cluster_version = var.kubernetes_version

  vpc_id     = data.aws_vpc.cluster.id
  subnet_ids = data.aws_subnets.private.ids

  cluster_endpoint_public_access  = true
  cluster_endpoint_private_access = true

  # Enable IRSA (IAM Roles for Service Accounts)
  enable_irsa = true

  # EKS Managed Node Groups
  eks_managed_node_groups = {
    primary = {
      name = "${var.cluster_name}-primary"

      instance_types = [var.node_instance_type]
      capacity_type  = "ON_DEMAND"

      min_size     = var.min_nodes
      max_size     = var.max_nodes
      desired_size = var.desired_nodes

      # Disk
      block_device_mappings = {
        xvda = {
          device_name = "/dev/xvda"
          ebs = {
            volume_size           = 50
            volume_type           = "gp3"
            encrypted             = true
            delete_on_termination = true
          }
        }
      }

      labels = {
        "role"    = "primary"
        "managed" = "idp-backstage"
      }

      tags = local.common_tags
    }
  }

  # Cluster access — allows cluster creator account-level admin
  enable_cluster_creator_admin_permissions = true

  cluster_addons = {
    coredns                = { most_recent = true }
    kube-proxy             = { most_recent = true }
    vpc-cni                = { most_recent = true }
    aws-ebs-csi-driver     = { most_recent = true }
  }

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# Helm / Kubernetes providers wired to the new cluster
# ---------------------------------------------------------------------------
provider "helm" {
  kubernetes {
    host                   = module.eks.cluster_endpoint
    cluster_ca_certificate = base64decode(module.eks.cluster_certificate_authority_data)
    exec {
      api_version = "client.authentication.k8s.io/v1beta1"
      command     = "aws"
      args        = ["eks", "get-token", "--cluster-name", module.eks.cluster_name, "--region", var.aws_region]
    }
  }
}

provider "kubernetes" {
  host                   = module.eks.cluster_endpoint
  cluster_ca_certificate = base64decode(module.eks.cluster_certificate_authority_data)
  exec {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "aws"
    args        = ["eks", "get-token", "--cluster-name", module.eks.cluster_name, "--region", var.aws_region]
  }
}

# ---------------------------------------------------------------------------
# Locals
# ---------------------------------------------------------------------------
locals {
  common_tags = {
    "managed-by"         = "idp-backstage"
    "cluster-name"       = var.cluster_name
    "kubernetes-version" = var.kubernetes_version
  }
}
