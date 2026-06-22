# Karpenter — just-in-time node provisioning for team workloads.
# Replaces managed node groups for the "services" tier; platform components
# (ArgoCD, Crossplane, Prometheus, etc.) stay on the on-demand managed node group.
#
# Node strategy:
#   platform node group (managed, on-demand) → runs with label role=platform
#   Karpenter NodePool (spot+on-demand mix)   → runs everything else
#
# Only provisioned when enable_karpenter = true (set in tfvars/eu-central-1.tfvars)

module "karpenter" {
  count   = var.enable_karpenter ? 1 : 0
  source  = "terraform-aws-modules/eks/aws//modules/karpenter"
  version = "~> 20.0"

  cluster_name           = module.eks.cluster_name
  irsa_oidc_provider_arn = module.eks.oidc_provider_arn

  # SQS queue for spot interruption and rebalance notifications — Karpenter
  # watches this queue and gracefully drains nodes before termination.
  enable_irsa                     = true
  irsa_namespace_service_accounts = ["kube-system:karpenter"]
  create_instance_profile         = true

  # EventBridge rules for EC2 lifecycle events → SQS → Karpenter
  enable_spot_termination = true

  tags = {
    "idp:component" = "karpenter"
    "idp:env"       = var.environment
  }
}

resource "helm_release" "karpenter" {
  count = var.enable_karpenter ? 1 : 0

  name       = "karpenter"
  repository = "oci://public.ecr.aws/karpenter"
  chart      = "karpenter"
  version    = "1.0.6"
  namespace  = "kube-system"

  set {
    name  = "settings.clusterName"
    value = module.eks.cluster_name
  }
  set {
    name  = "settings.interruptionQueue"
    value = module.karpenter[0].queue_name
  }
  set {
    name  = "serviceAccount.annotations.eks\\.amazonaws\\.com/role-arn"
    value = module.karpenter[0].iam_role_arn
  }
  set {
    name  = "controller.resources.requests.cpu"
    value = "250m"
  }
  set {
    name  = "controller.resources.requests.memory"
    value = "512Mi"
  }
  set {
    name  = "controller.resources.limits.memory"
    value = "1Gi"
  }

  depends_on = [module.eks, module.karpenter]
}

# EC2NodeClass — tells Karpenter which AMI, subnet, and security group to use
resource "kubectl_manifest" "karpenter_node_class" {
  count = var.enable_karpenter ? 1 : 0

  yaml_body = <<-YAML
    apiVersion: karpenter.k8s.aws/v1
    kind: EC2NodeClass
    metadata:
      name: default
    spec:
      amiFamily: AL2023
      role: ${module.karpenter[0].node_iam_role_name}
      subnetSelectorTerms:
        - tags:
            karpenter.sh/discovery: ${module.eks.cluster_name}
      securityGroupSelectorTerms:
        - tags:
            karpenter.sh/discovery: ${module.eks.cluster_name}
      tags:
        karpenter.sh/discovery: ${module.eks.cluster_name}
        idp:managed-by: karpenter
        idp:env: ${var.environment}
  YAML

  depends_on = [helm_release.karpenter]
}

# NodePool — defines the node fleet Karpenter can provision for team workloads
resource "kubectl_manifest" "karpenter_node_pool" {
  count = var.enable_karpenter ? 1 : 0

  yaml_body = <<-YAML
    apiVersion: karpenter.sh/v1
    kind: NodePool
    metadata:
      name: services
    spec:
      template:
        metadata:
          labels:
            role: services
            karpenter.sh/managed: "true"
        spec:
          nodeClassRef:
            group: karpenter.k8s.aws
            kind: EC2NodeClass
            name: default
          requirements:
            # Instance families — Graviton (arm64) preferred; fallback to x86_64
            - key: karpenter.k8s.aws/instance-family
              operator: In
              values: [m7g, m6g, c7g, c6g, r7g, r6g, m7i, m6i, c7i, c6i]
            - key: kubernetes.io/arch
              operator: In
              values: [arm64, amd64]
            # Capacity type — prefer spot, allow on-demand as fallback
            - key: karpenter.sh/capacity-type
              operator: In
              values: [spot, on-demand]
            # Avoid tiny instances that can't fit a typical service pod
            - key: karpenter.k8s.aws/instance-size
              operator: NotIn
              values: [nano, micro, small]
          # Kubelet config for faster pod startup
          kubelet:
            maxPods: 110
      limits:
        cpu: 1000         # max 1000 vCPUs across all Karpenter-managed nodes
        memory: 4000Gi
      disruption:
        consolidationPolicy: WhenEmptyOrUnderutilized
        consolidateAfter: 5m   # reclaim underutilised nodes after 5 minutes idle
  YAML

  depends_on = [kubectl_manifest.karpenter_node_class]
}

# Subnet and security group tags required by EC2NodeClass selectors
resource "aws_ec2_tag" "private_subnet_karpenter" {
  count       = var.enable_karpenter ? length(module.vpc.private_subnets) : 0
  resource_id = module.vpc.private_subnets[count.index]
  key         = "karpenter.sh/discovery"
  value       = module.eks.cluster_name
}

resource "aws_ec2_tag" "node_sg_karpenter" {
  count       = var.enable_karpenter ? 1 : 0
  resource_id = module.eks.node_security_group_id
  key         = "karpenter.sh/discovery"
  value       = module.eks.cluster_name
}
