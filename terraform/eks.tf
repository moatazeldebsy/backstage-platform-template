module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.0"

  cluster_name    = var.cluster_name
  cluster_version = var.cluster_version

  vpc_id                         = module.vpc.vpc_id
  subnet_ids                     = module.vpc.private_subnets
  cluster_endpoint_public_access = true

  # Enable IRSA (IAM Roles for Service Accounts)
  enable_irsa = true

  # Disable control plane logging — audit/API logs ingest at $0.50/GB and accumulate fast.
  # Enable selectively for production: ["api", "audit", "authenticator"]
  cluster_enabled_log_types = []

  cluster_addons = {
    coredns    = { most_recent = true }
    kube-proxy = { most_recent = true }
    vpc-cni    = { most_recent = true }
    aws-ebs-csi-driver = {
      most_recent              = true
      service_account_role_arn = aws_iam_role.ebs_csi_driver.arn
    }
  }

  # Platform node group (on-demand, always present) — runs ArgoCD, Crossplane,
  # Backstage, Prometheus, and other platform components that must not land on spot.
  # When Karpenter is enabled, team service workloads run on Karpenter-managed nodes
  # (labeled role=services) instead. Platform pods use a nodeSelector: {role: platform}.
  eks_managed_node_groups = {
    platform = {
      instance_types = var.node_instance_types
      min_size       = var.node_group_min_size
      max_size       = var.enable_karpenter ? 6 : var.node_group_max_size # cap platform NG when Karpenter takes over burst
      desired_size   = var.node_group_desired_size

      labels = {
        role = "platform"
      }

      taints = var.enable_karpenter ? [
        # Soft taint — platform components tolerate it; team services go to Karpenter nodes
        {
          key    = "idp/platform"
          value  = "true"
          effect = "PREFER_NO_SCHEDULE"
        }
      ] : []

      iam_role_additional_policies = {
        AmazonSSMManagedInstanceCore = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
        CloudWatchAgentServerPolicy  = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
      }
    }
  }

  # Grant cluster admin to the Terraform caller
  enable_cluster_creator_admin_permissions = true
}

# EKS access entry for GitHub Actions IAM role
resource "aws_eks_access_entry" "github_actions" {
  cluster_name  = module.eks.cluster_name
  principal_arn = aws_iam_role.github_actions.arn
  type          = "STANDARD"

  depends_on = [module.eks]
}

resource "aws_eks_access_policy_association" "github_actions_cluster_admin" {
  cluster_name  = module.eks.cluster_name
  principal_arn = aws_iam_role.github_actions.arn
  policy_arn    = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy"

  access_scope {
    type = "cluster"
  }

  depends_on = [aws_eks_access_entry.github_actions]
}

# AWS Load Balancer Controller
module "aws_load_balancer_controller_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.30"

  role_name                              = "${var.cluster_name}-aws-load-balancer-controller"
  attach_load_balancer_controller_policy = true

  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["kube-system:aws-load-balancer-controller"]
    }
  }
}

resource "helm_release" "aws_load_balancer_controller" {
  name       = "aws-load-balancer-controller"
  repository = "https://aws.github.io/eks-charts"
  chart      = "aws-load-balancer-controller"
  namespace  = "kube-system"
  version    = "1.8.4"

  set {
    name  = "clusterName"
    value = var.cluster_name
  }
  set {
    name  = "serviceAccount.annotations.eks\\.amazonaws\\.com/role-arn"
    value = module.aws_load_balancer_controller_irsa.iam_role_arn
  }

  depends_on = [module.eks]
}

# Retention policy for the EKS control plane log group.
# Without this, logs never expire (AWS default) and cost $0.03/GB/month indefinitely.
resource "aws_cloudwatch_log_group" "eks_cluster" {
  name              = "/aws/eks/${var.cluster_name}/cluster"
  retention_in_days = 7

  tags = {
    "idp:component" = "eks-control-plane"
    "idp:env"       = var.environment
  }
}
