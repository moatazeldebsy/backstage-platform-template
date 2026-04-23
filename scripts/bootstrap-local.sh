#!/usr/bin/env bash
# bootstrap-local.sh — Set up the full IDP MVP locally using Kind
# No AWS account needed. Mirrors the cloud setup with Kind + nginx + Prometheus.
#
# Usage:
#   ./scripts/bootstrap-local.sh              # full setup
#   ./scripts/bootstrap-local.sh --skip-obs  # skip observability (faster)
#   ./scripts/bootstrap-local.sh --destroy   # tear everything down
set -euo pipefail

CLUSTER_NAME="idp-mvp"
REGISTRY_NAME="registry"
REGISTRY_PORT="5003"
SKIP_OBS=false
SKIP_GITOPS=false
SKIP_POLICIES=false
SKIP_DORA=false
SKIP_ML=false
DESTROY=false

log()  { echo "[$(date +%T)] INFO  $*"; }
warn() { echo "[$(date +%T)] WARN  $*"; }
err()  { echo "[$(date +%T)] ERROR $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-obs)      SKIP_OBS=true;      shift ;;
    --skip-gitops)   SKIP_GITOPS=true;   shift ;;
    --skip-policies) SKIP_POLICIES=true; shift ;;
    --skip-dora)     SKIP_DORA=true;     shift ;;
    --skip-ml)       SKIP_ML=true;       shift ;;
    --destroy)       DESTROY=true;       shift ;;
    *) err "Unknown flag: $1" ;;
  esac
done

# ── Teardown path ─────────────────────────────────────────────────────────────
if $DESTROY; then
  log "Destroying local IDP platform..."
  helm uninstall argocd       -n argocd           2>/dev/null || true
  helm uninstall gatekeeper   -n gatekeeper-system 2>/dev/null || true
  kubectl delete namespace argocd gatekeeper-system finops 2>/dev/null || true
  kind delete cluster --name "$CLUSTER_NAME" 2>/dev/null || true
  docker stop "$REGISTRY_NAME" 2>/dev/null || true
  docker rm   "$REGISTRY_NAME" 2>/dev/null || true
  log "Done. Remove /etc/hosts entries manually if added."
  exit 0
fi

# ── Pre-flight ────────────────────────────────────────────────────────────────
for cmd in kind kubectl helm docker; do
  command -v "$cmd" &>/dev/null || err "'$cmd' not found. Install it first."
done

log "Starting local IDP MVP bootstrap (cluster=$CLUSTER_NAME)"

# ── Step 1: Local container registry ─────────────────────────────────────────
log "Step 1: Starting local container registry on port ${REGISTRY_PORT}..."

if ! docker inspect "$REGISTRY_NAME" &>/dev/null; then
  docker run -d \
    --restart=always \
    --name "$REGISTRY_NAME" \
    -p "127.0.0.1:${REGISTRY_PORT}:5000" \
    registry:2
  log "Registry started."
else
  log "Registry already running."
fi

# ── Step 2: Kind cluster ──────────────────────────────────────────────────────
log "Step 2: Creating Kind cluster '$CLUSTER_NAME'..."

if kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
  log "Cluster '$CLUSTER_NAME' already exists — skipping creation."
else
  kind create cluster \
    --name "$CLUSTER_NAME" \
    --config "$(dirname "$0")/../local/kind-config.yaml"
fi

kubectl config use-context "kind-${CLUSTER_NAME}"

# Connect registry to the Kind network so nodes can pull from it
if ! docker network inspect kind --format '{{range .Containers}}{{.Name}}{{"\n"}}{{end}}' 2>/dev/null | grep -q "^${REGISTRY_NAME}$"; then
  docker network connect kind "$REGISTRY_NAME" 2>/dev/null || true
fi

# Annotate nodes so containerd resolves localhost:5003 → registry:5001
kubectl apply -f - <<EOF
apiVersion: v1
kind: ConfigMap
metadata:
  name: local-registry-hosting
  namespace: kube-public
data:
  localRegistryHosting.v1: |
    host: "localhost:${REGISTRY_PORT}"
    help: "https://kind.sigs.k8s.io/docs/user/local-registry/"
EOF

# ── Step 3: Namespaces ────────────────────────────────────────────────────────
log "Step 3: Creating platform namespaces..."
kubectl apply -f "$(dirname "$0")/../kubernetes/namespaces/namespaces.yaml"
kubectl apply -f "$(dirname "$0")/../kubernetes/rbac/github-actions.yaml"

# ── Step 4: nginx ingress controller ─────────────────────────────────────────
log "Step 4: Installing nginx ingress controller..."
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update

helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx \
  --create-namespace \
  --set controller.hostPort.enabled=true \
  --set controller.service.type=NodePort \
  --set-string "controller.nodeSelector.ingress-ready=true" \
  --set "controller.tolerations[0].key=node-role.kubernetes.io/control-plane" \
  --set "controller.tolerations[0].operator=Exists" \
  --set "controller.tolerations[0].effect=NoSchedule" \
  --wait --timeout 5m

# ── Step 4b: metrics-server ───────────────────────────────────────────────────
log "Step 4b: Installing metrics-server (required for CPU/memory in Backstage)..."
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
# Kind uses self-signed kubelet certs — patch to skip TLS verification
kubectl patch deployment metrics-server -n kube-system --type=json \
  -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'

# ── Step 5: Observability ─────────────────────────────────────────────────────
if ! $SKIP_OBS; then
  log "Step 5: Installing Prometheus + Grafana (kube-prometheus-stack)..."
  helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
  helm repo update

  # Create Grafana dashboard ConfigMaps
  kubectl create namespace monitoring --dry-run=client -o yaml | kubectl apply -f -
  kubectl create configmap grafana-dashboards-idp \
    --from-file="$(dirname "$0")/../observability/grafana/dashboards/" \
    -n monitoring --dry-run=client -o yaml | kubectl apply -f -
  kubectl apply -f "$(dirname "$0")/../kubernetes/monitoring/grafana-dora-dashboard-configmap.yaml"
  kubectl apply -f "$(dirname "$0")/../kubernetes/monitoring/grafana-ai-agent-dashboard-configmap.yaml"
  kubectl apply -f "$(dirname "$0")/../kubernetes/monitoring/grafana-qa-dashboard-configmap.yaml"

  helm upgrade --install prometheus prometheus-community/kube-prometheus-stack \
    --namespace monitoring \
    --values "$(dirname "$0")/../local/observability/prometheus-stack-values.yaml" \
    --wait --timeout 10m
else
  log "Step 5: Skipping observability (--skip-obs)."
fi

# ── Step 6: Build and deploy hello-service ────────────────────────────────────
log "Step 6: Building and deploying hello-service..."
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="localhost:${REGISTRY_PORT}/hello-service:local"

docker build \
  --build-arg VERSION="local-$(git rev-parse --short HEAD 2>/dev/null || echo 'dev')" \
  -t "$IMAGE" \
  "${ROOT_DIR}/services/hello-service"

docker push "$IMAGE"

helm upgrade --install hello-service "${ROOT_DIR}/helm/service-template" \
  --namespace services \
  --set image.repository="localhost:${REGISTRY_PORT}/hello-service" \
  --set image.tag=local \
  --values "${ROOT_DIR}/services/hello-service/helm-values-local.yaml" \
  --wait

# ── Step 8: ArgoCD ────────────────────────────────────────────────────────────
if ! $SKIP_GITOPS; then
  log "Step 8: Installing ArgoCD..."
  helm repo add argo https://argoproj.github.io/argo-helm 2>/dev/null || true
  helm repo update

  helm upgrade --install argocd argo/argo-cd \
    --namespace argocd \
    --create-namespace \
    --version 7.7.16 \
    --values "${ROOT_DIR}/local/argocd/argocd-helm-values-local.yaml" \
    --wait --timeout 10m

  ARGOCD_PASS=$(kubectl -n argocd get secret argocd-initial-admin-secret \
    -o jsonpath="{.data.password}" 2>/dev/null | base64 -d || echo "(not yet available)")
  log "ArgoCD installed. UI: http://argocd.idp.local  (admin / ${ARGOCD_PASS})"
else
  log "Step 8: Skipping ArgoCD (--skip-gitops)."
fi

# ── Step 9: OPA/Gatekeeper ───────────────────────────────────────────────────
if ! $SKIP_POLICIES; then
  log "Step 9: Installing OPA/Gatekeeper..."
  helm repo add gatekeeper https://open-policy-agent.github.io/gatekeeper/charts 2>/dev/null || true
  helm repo update

  helm upgrade --install gatekeeper gatekeeper/gatekeeper \
    --namespace gatekeeper-system \
    --create-namespace \
    --version 3.18.2 \
    --set replicas=1 \
    --set controllerManager.resources.requests.cpu=100m \
    --set controllerManager.resources.requests.memory=128Mi \
    --set controllerManager.resources.limits.cpu=500m \
    --set controllerManager.resources.limits.memory=512Mi \
    --set audit.resources.requests.cpu=100m \
    --set audit.resources.requests.memory=128Mi \
    --set audit.resources.limits.cpu=500m \
    --set audit.resources.limits.memory=512Mi \
    --wait --timeout 10m

  log "Applying OPA ConstraintTemplates..."
  # Pass 1: apply full files — this creates the ConstraintTemplates (and fails on
  # Constraints because the CRDs don't exist yet; we ignore those errors here)
  kubectl apply \
    -f "${ROOT_DIR}/kubernetes/policies/require-health-probes.yaml" \
    -f "${ROOT_DIR}/kubernetes/policies/require-resource-limits.yaml" \
    -f "${ROOT_DIR}/kubernetes/policies/require-labels.yaml" \
    -f "${ROOT_DIR}/kubernetes/policies/deny-latest-tag.yaml" \
    -f "${ROOT_DIR}/kubernetes/policies/require-cost-tags.yaml" 2>/dev/null || true

  # Wait for Gatekeeper to register the CRDs from the ConstraintTemplates
  log "Waiting for ConstraintTemplate CRDs to become established..."
  kubectl wait crd \
    requirehealthprobes.constraints.gatekeeper.sh \
    requireresourcelimits.constraints.gatekeeper.sh \
    requirelabels.constraints.gatekeeper.sh \
    denylatestimgtag.constraints.gatekeeper.sh \
    requirecosttags.constraints.gatekeeper.sh \
    --for=condition=Established \
    --timeout=120s

  # Pass 2: now the CRDs exist — apply again to create the Constraint instances
  log "Applying OPA Constraints..."
  kubectl apply \
    -f "${ROOT_DIR}/kubernetes/policies/require-health-probes.yaml" \
    -f "${ROOT_DIR}/kubernetes/policies/require-resource-limits.yaml" \
    -f "${ROOT_DIR}/kubernetes/policies/require-labels.yaml" \
    -f "${ROOT_DIR}/kubernetes/policies/deny-latest-tag.yaml" \
    -f "${ROOT_DIR}/kubernetes/policies/require-cost-tags.yaml"

  log "OPA/Gatekeeper installed. Policies: health-probes, resource-limits, labels, deny-latest-tag (prod only), cost-tags."
else
  log "Step 9: Skipping OPA/Gatekeeper (--skip-policies)."
fi

# ── Step 10: OpenCost ─────────────────────────────────────────────────────────
log "Step 10: Deploying OpenCost..."
kubectl apply -f "${ROOT_DIR}/kubernetes/finops/opencost.yaml"
kubectl apply -f "${ROOT_DIR}/local/opencost/opencost-ingress.yaml"
# OpenCost needs baseline PSS (requires readOnlyRootFilesystem: false)
kubectl label namespace finops pod-security.kubernetes.io/enforce=baseline --overwrite
log "OpenCost deployed. UI: http://opencost.idp.local"

# ── Step 11: DORA Exporter (Pushgateway) ─────────────────────────────────────
if ! $SKIP_DORA; then
  if ! $SKIP_OBS; then
    log "Step 11: Installing Prometheus Pushgateway (separate release)..."
    helm upgrade --install prometheus-pushgateway prometheus-community/prometheus-pushgateway \
      --namespace monitoring \
      --set resources.requests.cpu=10m \
      --set resources.requests.memory=32Mi \
      --set resources.limits.cpu=100m \
      --set resources.limits.memory=64Mi \
      --set serviceMonitor.enabled=true \
      --set serviceMonitor.additionalLabels.release=prometheus \
      --wait --timeout 5m

    kubectl apply -f "${ROOT_DIR}/local/observability/pushgateway-ingress.yaml"
    log "Pushgateway ingress: http://pushgateway.idp.local"
  fi

  log "Step 11b: Applying DORA exporter (Pushgateway variant)..."
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    kubectl create secret generic dora-exporter-secret \
      --from-literal=GITHUB_TOKEN="${GITHUB_TOKEN}" \
      -n monitoring \
      --dry-run=client -o yaml | kubectl apply -f -
  else
    warn "GITHUB_TOKEN not set — DORA exporter will fail at runtime."
    warn "Run: kubectl create secret generic dora-exporter-secret \\"
    warn "  --from-literal=GITHUB_TOKEN='<your-pat>' -n monitoring"
  fi

  kubectl create configmap dora-exporter-script \
    --from-file=dora-exporter.py="${ROOT_DIR}/observability/dora/dora-exporter-local.py" \
    -n monitoring --dry-run=client -o yaml | kubectl apply -f -

  kubectl apply -f "${ROOT_DIR}/observability/dora/dora-cronjob-local.yaml"
  log "DORA exporter deployed (pushes to Prometheus Pushgateway every 15m)."
else
  log "Step 11: Skipping DORA exporter (--skip-dora)."
fi

# ── Step 12: AlertManager Slack webhook ───────────────────────────────────────
log "Step 12: Wiring AlertManager..."
if [[ -n "${SLACK_WEBHOOK_URL:-}" ]]; then
  kubectl create secret generic alertmanager-slack-webhook \
    --from-literal=webhook-url="${SLACK_WEBHOOK_URL}" \
    -n monitoring \
    --dry-run=client -o yaml | kubectl apply -f -
  kubectl apply -f "${ROOT_DIR}/observability/alertmanager/alertmanager-config.yaml"
  log "AlertManager Slack webhook configured."
else
  warn "SLACK_WEBHOOK_URL not set — skipping AlertManager Slack routing."
  warn "Set it and re-run, or:"
  warn "  kubectl create secret generic alertmanager-slack-webhook \\"
  warn "    --from-literal=webhook-url='https://hooks.slack.com/...' -n monitoring"
  warn "  kubectl apply -f observability/alertmanager/alertmanager-config.yaml"
fi

# ── Step 13: ArgoCD ApplicationSet ───────────────────────────────────────────
if ! $SKIP_GITOPS; then
  log "Step 13: Applying ArgoCD ApplicationSet (all environments)..."
  kubectl apply -f "${ROOT_DIR}/local/argocd/app-of-apps-local.yaml" -n argocd
  log "ApplicationSet applied. ArgoCD will sync hello-service to local/dev/staging/prod."
fi

# ── Step 14: ML Platform (MLflow + Argo Workflows) ──────────────────────────
if ! $SKIP_ML; then
  log "Step 14: Deploying ML Platform (MLflow + Argo Workflows)..."

  # Create namespace
  kubectl apply -f "${ROOT_DIR}/kubernetes/namespaces/namespaces.yaml"

  # Argo Workflows
  if ! helm repo list | grep -q '^argo'; then
    helm repo add argo https://argoproj.github.io/argo-helm
  fi
  helm repo update argo
  helm upgrade --install argo-workflows argo/argo-workflows \
    --namespace ml-platform \
    --version 0.44.0 \
    --values "${ROOT_DIR}/kubernetes/ml-platform/argo-workflows-values.yaml" \
    --wait --timeout 5m
  log "Argo Workflows deployed. UI: http://argo-workflows.idp.local"

  # MLflow
  if ! helm repo list | grep -q '^community-charts'; then
    helm repo add community-charts https://community-charts.github.io/helm-charts
  fi
  helm repo update community-charts
  helm upgrade --install mlflow community-charts/mlflow \
    --namespace ml-platform \
    --version 0.7.19 \
    --values "${ROOT_DIR}/kubernetes/ml-platform/mlflow-values.yaml" \
    --wait --timeout 5m
  log "MLflow deployed. UI: http://mlflow.idp.local"
else
  log "Step 14: Skipping ML Platform (--skip-ml)."
fi

# ── Step 7: /etc/hosts ───────────────────────────────────────────────────────
HOSTS_FILE="${ROOT_DIR}/local/hosts-append.txt"
if grep -qF "mlflow.idp.local" /etc/hosts 2>/dev/null; then
  log "Step 7: /etc/hosts entries already present — skipping."
else
  log "Step 7: Adding local hostnames to /etc/hosts (requires sudo)..."
  if sudo tee -a /etc/hosts < "${HOSTS_FILE}" > /dev/null; then
    log "  /etc/hosts updated. All *.idp.local hostnames are now resolvable."
  else
    warn "  Could not update /etc/hosts automatically. Add entries manually:"
    warn "  sudo sh -c \"cat ${HOSTS_FILE} >> /etc/hosts\""
  fi
fi

# ── Done ──────────────────────────────────────────────────────────────────────
log "Bootstrap complete!"
log ""
log "  hello-service:  http://hello-service.idp.local  (or http://localhost/)"
if ! $SKIP_OBS; then
log "  Grafana:        http://grafana.idp.local  (admin / admin)"
fi
if ! $SKIP_GITOPS; then
log "  ArgoCD:         http://argocd.idp.local"
fi
log "  OpenCost:       http://opencost.idp.local"
if ! $SKIP_ML; then
log "  MLflow:         http://mlflow.idp.local"
log "  Argo Workflows: http://argo-workflows.idp.local"
fi
log "  Backstage:      cd local/backstage && docker compose up -d"
log ""
log "For hot-reload dev:  tilt up"
log "Teardown:            ./scripts/bootstrap-local.sh --destroy"
