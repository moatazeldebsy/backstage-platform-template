locals {
  # With Karpenter on, team-service burst goes to Karpenter nodes, so the platform
  # node group is capped instead of growing to node_group_max_size. The cap used to
  # be a flat 6, which is below profiles/large's min (8) and desired (12): EKS
  # rejected the node group with min > max ~15 minutes into the apply, after the
  # control plane was already up. The cap now never drops below what the profile
  # asks the group to run.
  platform_node_group_max_size = (
    var.enable_karpenter
    ? max(6, var.node_group_min_size, var.node_group_desired_size)
    : var.node_group_max_size
  )

  # Spot for anything that is not prod: ~60-70% off the node line, and this
  # platform is rebuilt from IaC anyway. medium/large set environment = "prod"
  # and stay on-demand.
  platform_capacity_type = coalesce(
    var.node_capacity_type,
    var.environment == "prod" ? "ON_DEMAND" : "SPOT",
  )

  # A spot node group limited to one instance type fails to launch whenever
  # that one pool has no spare capacity. Same-size alternatives (vCPU and
  # memory) widen it. On-demand keeps exactly the configured types.
  spot_alternatives = {
    "t3.medium" = ["t3a.medium", "c5.large", "c5a.large", "c6i.large", "c6a.large"]
    "t3.large"  = ["t3a.large", "m5.large", "m5a.large", "m6i.large", "m6a.large"]
    "m5.xlarge" = ["m5a.xlarge", "m6i.xlarge", "m6a.xlarge", "m7i.xlarge"]
  }
  platform_instance_types = (
    local.platform_capacity_type == "SPOT"
    ? distinct(concat(var.node_instance_types, flatten([for t in var.node_instance_types : lookup(local.spot_alternatives, t, [])])))
    : var.node_instance_types
  )
}

# Fails `terraform plan` instead of the EKS CreateNodegroup call.
resource "terraform_data" "node_group_sizing_check" {
  lifecycle {
    precondition {
      condition = (
        var.node_group_min_size <= var.node_group_desired_size &&
        var.node_group_desired_size <= local.platform_node_group_max_size
      )
      error_message = "Platform node group sizing must satisfy min <= desired <= max (min=${var.node_group_min_size}, desired=${var.node_group_desired_size}, max=${local.platform_node_group_max_size})."
    }
  }
}

module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.0"

  cluster_name    = var.cluster_name
  cluster_version = var.cluster_version

  # STANDARD: when this version's standard support ends, EKS upgrades the
  # control plane to the next version instead of silently moving the cluster
  # to extended support, which bills $0.60/h rather than $0.10/h. That is
  # exactly what happened on 1.32 (~$0.50/h extra for every hour the cluster
  # was up). The trade-off is an unscheduled minor-version upgrade if
  # cluster_version is never bumped, which is the better failure for a
  # platform that is rebuilt from IaC.
  cluster_upgrade_policy = {
    support_type = "STANDARD"
  }

  vpc_id                         = module.vpc.vpc_id
  subnet_ids                     = module.vpc.private_subnets
  cluster_endpoint_public_access = true
  # Who can reach the public API endpoint at all. Defaults to everyone, because
  # bootstrap.sh and CI (GitHub-hosted runners) both call it from outside the
  # VPC; set eks_public_access_cidrs to your office/VPN ranges where you can.
  # Nodes and in-VPC callers use the private endpoint either way.
  cluster_endpoint_public_access_cidrs = var.eks_public_access_cidrs

  # Enable IRSA (IAM Roles for Service Accounts)
  enable_irsa = true

  # Control-plane logs ingest at $0.50/GB, so they follow the profile: off by
  # default, and api/audit/authenticator on medium/large (profiles/*.tfvars).
  # Without the audit log there is no record of who did what with the
  # cluster-admin paths (CI role, cluster creator), during or after an incident.
  cluster_enabled_log_types = var.eks_control_plane_log_types

  # We manage the log group ourselves (aws_cloudwatch_log_group.eks_cluster below) to
  # control retention/tags — without this, the module creates its own with different
  # settings and the two fight over the same log group name on every apply.
  create_cloudwatch_log_group = false

  cluster_addons = {
    coredns    = { most_recent = true }
    kube-proxy = { most_recent = true }
    # Prefix delegation: each ENI slot gets a /28 (16 IPs) instead of one IP.
    # Karpenter's EC2NodeClass sets kubelet maxPods: 110 (karpenter.tf); without
    # this a c6g.large has ~29 pod IPs, and pods past that sat in
    # ContainerCreating with "failed to assign an IP address". before_compute
    # applies it ahead of the node groups so their first nodes already use it;
    # existing nodes pick it up when they are replaced.
    vpc-cni = {
      most_recent    = true
      before_compute = true
      configuration_values = jsonencode({
        env = {
          ENABLE_PREFIX_DELEGATION = "true"
          WARM_PREFIX_TARGET       = "1"
        }
      })
    }
    aws-ebs-csi-driver = {
      most_recent              = true
      service_account_role_arn = aws_iam_role.ebs_csi_driver.arn
    }
    # metrics-server. bootstrap-local.sh installs this for Kind at Step 4b
    # ("required for CPU/memory in Backstage") but nothing installed it on EKS, so
    # the metrics.k8s.io API simply did not exist there. Backstage's Kubernetes tab
    # queries it for every entity and reported, on every page,
    #   Error fetching Kubernetes resource:
    #   '/apis/metrics.k8s.io/v1beta1/namespaces/<ns>/pods', NOT_FOUND, 404
    # while warning that the Error Reporting card might be inaccurate. The
    # backstage-read ClusterRole already granted metrics.k8s.io — the permission was
    # never the problem, the API was absent. `kubectl top` also returned nothing, and
    # any HPA using resource metrics could not have scaled. Observed 2026-08-13.
    #
    # Delivered as an EKS managed addon rather than the upstream manifest local uses,
    # so AWS keeps it patched the same way it does coredns and vpc-cni.
    metrics-server = { most_recent = true }
  }

  # The Kubernetes aggregation layer calls metrics-server FROM the control plane to
  # the node, and the EKS-managed addon serves on 10251. The module's default node
  # rules cover 4443 and 10250 but not 10251, so the APIService sat at
  #   Available=False (FailedDiscoveryCheck): failing or missing response from
  #   https://<node-ip>:10251/apis/metrics.k8s.io/v1beta1 — request canceled
  # with metrics-server itself healthy at 2/2 and `kubectl top` reporting
  # "Metrics API not available". The only wide rule on the node SG (3000-31141) is
  # sourced from the LOAD BALANCER security group, not the cluster one, so it does
  # not help here. Observed 2026-08-13.
  node_security_group_additional_rules = {
    metrics_server_from_control_plane = {
      description                   = "Control plane to metrics-server (aggregation layer)"
      protocol                      = "tcp"
      from_port                     = 10251
      to_port                       = 10251
      type                          = "ingress"
      source_cluster_security_group = true
    }
  }

  # Platform node group (always present) — runs ArgoCD, Crossplane, Backstage,
  # Prometheus, and other platform components that must not land on spot. When
  # Karpenter is enabled, team service workloads run on Karpenter's `services`
  # NodePool (labeled role=services, tainted idp/services — karpenter.tf), which
  # platform pods do not tolerate; platform overflow goes to the on-demand
  # `platform` NodePool. Nothing selects this group by label.
  eks_managed_node_groups = {
    platform = {
      instance_types = local.platform_instance_types
      capacity_type  = local.platform_capacity_type
      min_size       = var.node_group_min_size
      max_size       = local.platform_node_group_max_size
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

    # Memory-optimised node group for Prometheus/MLflow/other memory-heavy workloads.
    # Scales to zero by default — costs nothing unless a pod actually tolerates the
    # taint and opts in via nodeSelector: {role: memory-optimized}.
    memory_optimized = {
      instance_types = var.memory_optimized_instance_types
      min_size       = 0
      max_size       = 3
      desired_size   = 0

      labels = {
        role = "memory-optimized"
      }

      taints = [
        {
          key    = "idp/memory-optimized"
          value  = "true"
          effect = "NO_SCHEDULE"
        }
      ]

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

# PR-run role (iam.tf github_actions_pr): no access policy, only a Kubernetes
# group whose namespaced Roles live in kubernetes/rbac/github-actions.yaml.
resource "aws_eks_access_entry" "github_actions_pr" {
  cluster_name      = module.eks.cluster_name
  principal_arn     = aws_iam_role.github_actions_pr.arn
  type              = "STANDARD"
  kubernetes_groups = ["idp:ci-pr-reader"]

  depends_on = [module.eks]
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
  name = "/aws/eks/${var.cluster_name}/cluster"
  # 7 days is enough for debugging, not for an audit trail; profiles that turn
  # the audit log on raise it (eks_control_plane_log_retention_days).
  retention_in_days = var.eks_control_plane_log_retention_days

  tags = {
    "idp:component" = "eks-control-plane"
    "idp:env"       = var.environment
  }
}
