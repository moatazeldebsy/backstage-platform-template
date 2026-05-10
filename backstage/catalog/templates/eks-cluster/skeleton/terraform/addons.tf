# ---------------------------------------------------------------------------
# Platform addons — each conditionally installed based on var.addons list
# ---------------------------------------------------------------------------

# ingress-nginx
resource "helm_release" "ingress_nginx" {
  count = contains(var.addons, "ingress-nginx") ? 1 : 0

  name             = "ingress-nginx"
  namespace        = "ingress-nginx"
  create_namespace = true
  repository       = "https://kubernetes.github.io/ingress-nginx"
  chart            = "ingress-nginx"
  version          = "4.10.1"

  set {
    name  = "controller.service.type"
    value = "LoadBalancer"
  }

  set {
    name  = "controller.metrics.enabled"
    value = "true"
  }

  depends_on = [module.eks]
}

# cert-manager
resource "helm_release" "cert_manager" {
  count = contains(var.addons, "cert-manager") ? 1 : 0

  name             = "cert-manager"
  namespace        = "cert-manager"
  create_namespace = true
  repository       = "https://charts.jetstack.io"
  chart            = "cert-manager"
  version          = "v1.15.1"

  set {
    name  = "installCRDs"
    value = "true"
  }

  depends_on = [module.eks]
}

# ArgoCD
resource "helm_release" "argocd" {
  count = contains(var.addons, "argocd") ? 1 : 0

  name             = "argocd"
  namespace        = "argocd"
  create_namespace = true
  repository       = "https://argoproj.github.io/argo-helm"
  chart            = "argo-cd"
  version          = "7.3.11"

  set {
    name  = "server.service.type"
    value = "ClusterIP"
  }

  depends_on = [module.eks]
}

# kube-prometheus-stack
resource "helm_release" "prometheus" {
  count = contains(var.addons, "prometheus") ? 1 : 0

  name             = "prometheus"
  namespace        = "monitoring"
  create_namespace = true
  repository       = "https://prometheus-community.github.io/helm-charts"
  chart            = "kube-prometheus-stack"
  version          = "61.7.2"

  set {
    name  = "grafana.enabled"
    value = "true"
  }

  set {
    name  = "prometheus.prometheusSpec.retention"
    value = "15d"
  }

  depends_on = [module.eks]
}
