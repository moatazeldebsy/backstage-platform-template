variable "cluster_name" {
  description = "EKS cluster name"
  type        = string
  default     = "${{ values.clusterName }}"
}

variable "aws_region" {
  description = "AWS region to create the cluster in"
  type        = string
  default     = "${{ values.awsRegion }}"
}

variable "kubernetes_version" {
  description = "Kubernetes version"
  type        = string
  default     = "${{ values.kubernetesVersion }}"
}

variable "node_instance_type" {
  description = "EC2 instance type for worker nodes"
  type        = string
  default     = "${{ values.nodeInstanceType }}"
}

variable "min_nodes" {
  description = "Minimum number of worker nodes"
  type        = number
  default     = ${{ values.minNodes }}
}

variable "max_nodes" {
  description = "Maximum number of worker nodes"
  type        = number
  default     = ${{ values.maxNodes }}
}

variable "desired_nodes" {
  description = "Desired number of worker nodes"
  type        = number
  default     = ${{ values.desiredNodes }}
}

variable "addons" {
  description = "Platform addons to install: ingress-nginx, cert-manager, argocd, prometheus"
  type        = list(string)
  default     = ${{ values.addons | dump }}
}
