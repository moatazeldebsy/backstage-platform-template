#!/usr/bin/env bash
# bootstrap-local.sh — Set up the full IDP MVP locally using Kind
# No AWS account needed. Mirrors the cloud setup with Kind + nginx + Prometheus.
#
# Usage:
#   ./scripts/bootstrap-local.sh                   # full cluster + platform setup
#   ./scripts/bootstrap-local.sh --skip-obs        # skip observability (faster)
#   ./scripts/bootstrap-local.sh --start-backstage # build + start Backstage, wire nginx, seed metrics
#   ./scripts/bootstrap-local.sh --update-backstage-ip  # refresh Backstage endpoint IP after compose up
#   ./scripts/bootstrap-local.sh --destroy              # tear everything down
#   ./scripts/bootstrap-local.sh --clean-docker         # stop Backstage + prune all Docker resources
#
# Scope: cluster creation, ingress, observability, ArgoCD, OPA, DORA exporter,
#        K8s credentials (local/backstage/.env), and catalog exporter CronJob.
# Called by setup.sh (first-time) and usable standalone for day-2 cluster recreates.
set -euo pipefail

# Resolved once here so every step and the early-exit paths can use it.
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# shellcheck source=scripts/lib.sh
source "${ROOT_DIR}/scripts/lib.sh"

CLUSTER_NAME="${CLUSTER_NAME:-idp-mvp}"
REGISTRY_NAME="registry"
REGISTRY_PORT="5003"
SKIP_OBS=false
SKIP_GITOPS=false
SKIP_POLICIES=false
SKIP_DORA=false
DESTROY=false
UPDATE_BACKSTAGE_IP=false
START_BACKSTAGE=false

# ── Source local/.env to pick up GITHUB_ORG and PLATFORM_REPO ────────────────
# Then apply any remaining YOUR_GITHUB_ORG / YOUR_PLATFORM_REPO placeholders
# so that templates and catalog files are always personalised on every bootstrap.
_apply_personalization() {
  local env_file="${ROOT_DIR}/local/.env"
  if [[ ! -f "$env_file" ]]; then
    warn "local/.env not found — skipping placeholder substitution."
    warn "Run ./scripts/setup.sh first, or create local/.env from local/.env.example."
    return
  fi

  local github_org platform_repo
  github_org=$(grep -E '^GITHUB_ORG=' "$env_file" | cut -d= -f2- | tr -d '"' || true)
  platform_repo=$(grep -E '^PLATFORM_REPO=' "$env_file" | cut -d= -f2- | tr -d '"' || true)

  if [[ -z "$github_org" || "$github_org" == "YOUR_GITHUB_ORG" ]]; then
    warn "GITHUB_ORG is not set in local/.env — skipping placeholder substitution."
    return
  fi

  log "Applying personalisation: YOUR_GITHUB_ORG → ${github_org}"

  local targets
  targets=$(LC_ALL=C find \
    "${ROOT_DIR}/backstage/catalog" \
    "${ROOT_DIR}/backstage/app-config.yaml" \
    "${ROOT_DIR}/kubernetes" \
    "${ROOT_DIR}/local/argocd" \
    "${ROOT_DIR}/observability" \
    "${ROOT_DIR}/services" \
    -type f \
    ! -name '*.png' ! -name '*.jpg' ! -name '*.ico' \
    2>/dev/null)

  echo "$targets" | xargs -I{} _sed "s/YOUR_GITHUB_ORG/${github_org}/g" {} 2>/dev/null || true

  if [[ -n "$platform_repo" && "$platform_repo" != "YOUR_PLATFORM_REPO" && "$platform_repo" != "backstage-idp-starter" ]]; then
    echo "$targets" | xargs -I{} _sed "s/backstage-idp-starter/${platform_repo}/g" {} 2>/dev/null || true
  fi

  log "Personalisation applied."
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-obs)      SKIP_OBS=true;      shift ;;
    --skip-gitops)   SKIP_GITOPS=true;   shift ;;
    --skip-policies) SKIP_POLICIES=true; shift ;;
    --skip-dora)     SKIP_DORA=true;     shift ;;
    --destroy)             DESTROY=true;            shift ;;
    --clean-docker)        CLEAN_DOCKER=true;       shift ;;
    --update-backstage-ip) UPDATE_BACKSTAGE_IP=true;  shift ;;
    --start-backstage)     START_BACKSTAGE=true;    shift ;;
    *) err "Unknown flag: $1" ;;
  esac
done

# ── Docker deep-clean helper ──────────────────────────────────────────────────
_clean_docker() {
  log "Stopping Backstage Docker Compose stack..."
  docker compose -f "${ROOT_DIR}/local/backstage/docker-compose.yml" \
    down --volumes --remove-orphans --rmi all 2>/dev/null || true

  log "Stopping and removing local registry container..."
  docker stop "$REGISTRY_NAME" 2>/dev/null || true
  docker rm   "$REGISTRY_NAME" 2>/dev/null || true

  log "Removing all unused Docker images..."
  docker image prune -a --force 2>/dev/null || true

  log "Removing all unused Docker volumes..."
  docker volume prune --force 2>/dev/null || true

  log "Pruning Docker build cache (all builders)..."
  docker buildx prune --all --force 2>/dev/null || true
  docker buildx prune --all --force --builder desktop-linux 2>/dev/null || true

  log "Docker clean complete."
}

# ── --clean-docker fast path ──────────────────────────────────────────────────
if ${CLEAN_DOCKER:-false}; then
  _clean_docker
  exit 0
fi

# ── Teardown path ─────────────────────────────────────────────────────────────
if $DESTROY; then
  log "Destroying local IDP platform..."
  # Delete the Kind cluster first — this removes all namespaces, Helm release
  # state (stored as k8s secrets), and workloads in one shot. No need to
  # helm uninstall each release individually before cluster deletion.
  kind delete cluster --name "$CLUSTER_NAME" 2>/dev/null || true
  # Stop the Backstage Docker Compose stack and remove the local registry.
  # Skip the full docker prune — use --clean-docker separately if needed.
  docker compose -f "${ROOT_DIR}/local/backstage/docker-compose.yml" \
    down --volumes --remove-orphans 2>/dev/null || true
  docker stop "$REGISTRY_NAME" 2>/dev/null || true
  docker rm   "$REGISTRY_NAME" 2>/dev/null || true
  log "Done."
  log ""
  log "Cleaning up /etc/hosts entries..."
  HOSTS_REMOVED=false
  while IFS= read -r line; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    hostname=$(awk '{print $2}' <<< "$line")
    [[ -z "$hostname" ]] && continue
    if grep -qF "$hostname" /etc/hosts 2>/dev/null; then
      if sudo sed -i.bak "/$(echo "$hostname" | sed 's/\./\\./g')/d" /etc/hosts; then
        log "  Removed: $hostname"
        HOSTS_REMOVED=true
      else
        warn "  Could not remove '$hostname' from /etc/hosts — remove it manually."
      fi
    fi
  done < "${ROOT_DIR}/local/hosts-append.txt"
  if $HOSTS_REMOVED; then
    sudo rm -f /etc/hosts.bak
    if [[ "$(uname)" == "Darwin" ]]; then
      sudo dscacheutil -flushcache 2>/dev/null || true
      sudo killall -HUP mDNSResponder 2>/dev/null || true
      log "  macOS DNS cache flushed."
    elif command -v resolvectl &>/dev/null; then
      sudo resolvectl flush-caches 2>/dev/null || true
    fi
  else
    log "  No matching /etc/hosts entries found — nothing to remove."
  fi
  exit 0
fi

# ── Helper: apply Backstage K8s Service, Endpoints, and nginx Ingress ────────
# Auto-detects the live container IP on the 'kind' Docker network so nginx can
# proxy to the Docker Compose Backstage container. Falls back to the hardcoded
# default (172.21.0.6) when the container is not yet running.
apply_backstage_k8s_objects() {
  local endpoints_file="${ROOT_DIR}/local/backstage/backstage-k8s-endpoints.yaml"
  local ingress_file="${ROOT_DIR}/local/backstage/backstage-ingress.yaml"

  local bs_ip
  bs_ip=$(docker inspect backstage-backstage-1 \
    --format '{{(index .NetworkSettings.Networks "kind").IPAddress}}' 2>/dev/null || true)

  if [[ -n "$bs_ip" && "$bs_ip" != "<no value>" ]]; then
    log "  Backstage container IP on kind network: ${bs_ip}"
    sed "s/ip: \"[0-9.]*\"/ip: \"${bs_ip}\"/" "$endpoints_file" | kubectl apply -f -
  else
    warn "  Backstage container not running — applying with default IP (172.21.0.6)."
    warn "  After 'docker compose up -d', run: ./scripts/bootstrap-local.sh --update-backstage-ip"
    kubectl apply -f "$endpoints_file"
  fi

  kubectl apply -f "$ingress_file"
  log "  Backstage Service, Endpoints, and nginx Ingress applied."
}

# ── --update-backstage-ip fast path ──────────────────────────────────────────
# Run after 'docker compose up' to refresh the Backstage Endpoints IP.
if $UPDATE_BACKSTAGE_IP; then
  kubectl config use-context "kind-${CLUSTER_NAME}" 2>/dev/null || true
  log "Re-applying Backstage K8s objects with updated container IP..."
  apply_backstage_k8s_objects
  log "Done. Test with: curl -sv http://backstage.idp.local"
  exit 0
fi

# ── --start-backstage fast path ───────────────────────────────────────────────
# Build + start Backstage, wire nginx routing, seed QA metrics, trigger catalog
# export. Run after 'bootstrap-local.sh' finishes, or as a day-2 restart path.
_start_backstage() {
  step "Starting Backstage..."
  kubectl config use-context "kind-${CLUSTER_NAME}" 2>/dev/null || true

  log "Building and starting Backstage Docker Compose..."
  docker compose -f "${ROOT_DIR}/local/backstage/docker-compose.yml" build backstage
  docker compose -f "${ROOT_DIR}/local/backstage/docker-compose.yml" up -d
  log "Backstage starting at http://localhost:3000 (allow ~30s)"

  log "Waiting for Backstage container to join the kind network..."
  for _i in {1..24}; do
    _bs_ip=$(docker inspect backstage-backstage-1 \
      --format '{{(index .NetworkSettings.Networks "kind").IPAddress}}' 2>/dev/null || true)
    if [[ -n "$_bs_ip" && "$_bs_ip" != "<no value>" ]]; then
      log "  Container IP on kind network: ${_bs_ip}"
      break
    fi
    log "  Not on kind network yet (${_i}/24) — retrying in 5s..."
    sleep 5
  done

  log "Wiring nginx → Backstage endpoint..."
  apply_backstage_k8s_objects

  log "Seeding sample QA metrics into Pushgateway..."
  kubectl port-forward svc/prometheus-pushgateway 9091:9091 -n monitoring &>/dev/null &
  _PFORWARD_PID=$!
  for _i in {1..10}; do
    if curl -sf http://localhost:9091/-/healthy &>/dev/null; then break; fi
    sleep 2
  done
  PUSHGATEWAY_URL=http://localhost:9091 "${ROOT_DIR}/scripts/seed-qa-metrics.sh" \
    || warn "Could not seed QA metrics — run manually:
  kubectl port-forward svc/prometheus-pushgateway 9091:9091 -n monitoring &
  PUSHGATEWAY_URL=http://localhost:9091 ./scripts/seed-qa-metrics.sh"
  kill "${_PFORWARD_PID}" 2>/dev/null || true
  wait "${_PFORWARD_PID}" 2>/dev/null || true

  log "Triggering catalog export..."
  "${ROOT_DIR}/scripts/apply-catalog-exporter.sh" \
    || warn "Could not trigger catalog export — run manually: ./scripts/apply-catalog-exporter.sh"

  step "Done!"
  echo ""
  echo -e "${GREEN}✓ Local IDP platform is up.${RESET}"
  echo ""
  echo -e "${BOLD}Access URLs:${RESET}"
  echo "  Backstage:     http://localhost:3000  (or http://backstage.idp.local)"
  echo "  hello-service: http://hello-service.idp.local"
  echo "  Grafana:       http://grafana.idp.local          (admin / admin)"
  echo "  ArgoCD:        http://argocd.idp.local"
  echo "  OpenCost:      http://opencost.idp.local"
  echo ""
  echo -e "${BOLD}Day-2 tools:${RESET}"
  echo "  Scaffold a service:   ./scripts/create-service.sh --name my-svc --type nodejs"
  echo "  Register a CI runner: ./scripts/setup-runner.sh --repo <repo-name>"
  echo "  Seed QA demo metrics: ./scripts/seed-qa-metrics.sh"
  echo "  Restart Backstage:    ./scripts/bootstrap-local.sh --start-backstage"
  echo "  Teardown cluster:     ./scripts/bootstrap-local.sh --destroy"
  echo ""
  echo "  Commit your personalised repo:"
  echo "    git add . && git commit -m 'chore: initialise from backstage-idp-starter'"
  echo ""
}

if $START_BACKSTAGE; then
  _start_backstage
  exit 0
fi

# ── Pre-flight ────────────────────────────────────────────────────────────────
_preflight_check_local

# ── Build idp CLI if not already built ────────────────────────────────────────
if [[ ! -x "${ROOT_DIR}/bin/idp" ]]; then
  if command -v go &>/dev/null; then
    log "Building idp CLI..."
    (cd "${ROOT_DIR}/cli" && go build -o "${ROOT_DIR}/bin/idp" ./cmd/idp) && \
      log "idp CLI built → ${ROOT_DIR}/bin/idp" || \
      warn "idp CLI build failed — run 'make cli-build' manually."
  else
    warn "Go not found — idp CLI not built. Install Go then run: make cli-build"
  fi
fi

# ── Personalisation: replace any remaining YOUR_GITHUB_ORG placeholders ──────
_apply_personalization

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

# ── Step 4c: Backstage K8s Service, Endpoints, and nginx Ingress ─────────────
# Wires the nginx controller to the Backstage Docker Compose container so that
# http://backstage.idp.local routes correctly through the Kind cluster ingress.
log "Step 4c: Applying Backstage K8s Service + Endpoints + nginx Ingress..."
apply_backstage_k8s_objects

# ── Step 4d: Backstage K8s credentials ───────────────────────────────────────
log "Step 4d: Extracting K8s credentials for Backstage plugin..."
"${ROOT_DIR}/scripts/get-k8s-credentials.sh"
log "  K8s credentials written to local/backstage/.env"

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
  kubectl apply -f "$(dirname "$0")/../kubernetes/monitoring/grafana-qa-dashboard-configmap.yaml"

  helm upgrade --install prometheus prometheus-community/kube-prometheus-stack \
    --namespace monitoring \
    --values "$(dirname "$0")/../local/observability/prometheus-stack-values.yaml" \
    --wait --timeout 10m

  log "  Waiting for Grafana API to be ready..."
  for _i in {1..24}; do
    if kubectl exec -n monitoring deploy/prometheus-grafana -c grafana -- \
        curl -sf http://localhost:3000/api/health &>/dev/null 2>&1; then
      break
    fi
    log "  Grafana not ready yet (${_i}/24) — retrying in 5s..."
    sleep 5
  done

  log "  Provisioning Grafana Viewer token for Backstage proxy..."
  GRAFANA_SA_ID=$(kubectl exec -n monitoring deploy/prometheus-grafana -c grafana -- \
    curl -sf -u admin:admin -X POST http://localhost:3000/api/serviceaccounts \
    -H 'Content-Type: application/json' \
    -d '{"name":"backstage","role":"Viewer"}' 2>/dev/null \
    | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2 || echo "")
  if [[ -n "$GRAFANA_SA_ID" ]]; then
    GRAFANA_TOKEN=$(kubectl exec -n monitoring deploy/prometheus-grafana -c grafana -- \
      curl -sf -u admin:admin -X POST "http://localhost:3000/api/serviceaccounts/${GRAFANA_SA_ID}/tokens" \
      -H 'Content-Type: application/json' \
      -d '{"name":"backstage-token"}' 2>/dev/null \
      | grep -o '"key":"[^"]*"' | cut -d'"' -f4 || echo "")
    if [[ -n "$GRAFANA_TOKEN" ]]; then
      local_env="${ROOT_DIR}/local/backstage/.env"
      if grep -q "^GRAFANA_TOKEN=" "$local_env" 2>/dev/null; then
        sed -i.bak "s|^GRAFANA_TOKEN=.*|GRAFANA_TOKEN=${GRAFANA_TOKEN}|" "$local_env" && rm -f "${local_env}.bak"
      else
        echo "GRAFANA_TOKEN=${GRAFANA_TOKEN}" >> "$local_env"
      fi
      log "  Grafana token written to local/backstage/.env (GRAFANA_TOKEN)"
    else
      warn "  Could not extract Grafana token — set GRAFANA_TOKEN manually in local/backstage/.env"
    fi
  else
    warn "  Could not create Grafana service account — set GRAFANA_TOKEN manually in local/backstage/.env"
  fi
else
  log "Step 5: Skipping observability (--skip-obs)."
fi

# ── Step 5b: OpenCost ────────────────────────────────────────────────────────
if ! $SKIP_OBS; then
  log "Step 5b: Installing OpenCost (cluster cost visibility)..."
  helm repo add opencost https://opencost.github.io/opencost-helm-chart 2>/dev/null || true
  helm repo update

  kubectl apply -f "${ROOT_DIR}/kubernetes/finops/opencost.yaml"

  helm upgrade --install opencost opencost/opencost \
    --namespace opencost \
    --set opencost.prometheus.internal.enabled=false \
    --set opencost.prometheus.external.enabled=true \
    --set "opencost.prometheus.external.url=http://prometheus-kube-prometheus-prometheus.monitoring.svc.cluster.local:9090" \
    --set opencost.exporter.defaultClusterId="${CLUSTER_NAME}" \
    --wait --timeout 5m

  log "OpenCost installed. UI: http://opencost.idp.local"
else
  log "Step 5b: Skipping OpenCost (--skip-obs)."
fi

# ── Step 6: Build and deploy hello-service ────────────────────────────────────
log "Step 6: Building and deploying hello-service..."
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

# Pre-load the nginx-prometheus-exporter sidecar image into the local registry.
# Kind nodes pull from localhost:5003 to avoid Docker Hub rate limits and to
# work fully offline after the first bootstrap.
NGINX_EXPORTER_IMG="nginx/nginx-prometheus-exporter:1.3.0"
NGINX_EXPORTER_LOCAL="localhost:${REGISTRY_PORT}/nginx-prometheus-exporter:1.3.0"
if ! curl -s "http://localhost:${REGISTRY_PORT}/v2/nginx-prometheus-exporter/tags/list" | grep -q '"1.3.0"'; then
  log "Step 6b: Seeding nginx-prometheus-exporter into local registry..."
  docker pull "${NGINX_EXPORTER_IMG}" --quiet
  docker tag  "${NGINX_EXPORTER_IMG}" "${NGINX_EXPORTER_LOCAL}"
  docker push "${NGINX_EXPORTER_LOCAL}"
  log "  Pushed ${NGINX_EXPORTER_LOCAL}"
else
  log "Step 6b: nginx-prometheus-exporter:1.3.0 already in registry — skipping."
fi

# Build and seed images for any scaffolded service in services/ that has a
# helm-values-local.yaml. hello-service is handled above; idp-mcp-server and
# qa-mcp-server are deployed by bootstrap-ai.sh — skip them here.
for svc_dir in "${ROOT_DIR}/services"/*/; do
  svc=$(basename "$svc_dir")
  [[ "$svc" == "hello-service" || "$svc" == "idp-mcp-server" || "$svc" == "qa-mcp-server" ]] && continue
  [[ ! -f "${svc_dir}/helm-values-local.yaml" ]] && continue
  img_repo=$(grep -E '^\s+repository:' "${svc_dir}/helm-values-local.yaml" | head -1 | awk '{print $2}')
  img_tag=$(grep -E '^\s+tag:' "${svc_dir}/helm-values-local.yaml" | head -1 | awk '{print $2}' | tr -d '"')
  [[ "$img_repo" != localhost:* ]] && continue
  svc_name=$(basename "$img_repo")
  if ! curl -s "http://localhost:${REGISTRY_PORT}/v2/${svc_name}/tags/list" | grep -q "\"${img_tag}\""; then
    if [[ -f "${svc_dir}/Dockerfile" ]]; then
      log "Step 6d: Building ${svc_name} from services/${svc}/Dockerfile..."
      docker build -t "${img_repo}:${img_tag}" "${svc_dir}" --quiet
    else
      log "Step 6d: Seeding ${img_repo}:${img_tag} stub (no Dockerfile found)..."
      docker build -t "${img_repo}:${img_tag}" -f - . <<'DOCKERFILE'
FROM python:3.13-slim
EXPOSE 8080
CMD ["python3", "-c", "import http.server, socketserver; socketserver.TCPServer(('',8080), http.server.SimpleHTTPRequestHandler).serve_forever()"]
DOCKERFILE
    fi
    docker push "${img_repo}:${img_tag}"
    log "  Pushed ${img_repo}:${img_tag}"
  else
    log "Step 6c: ${img_repo}:${img_tag} already in registry — skipping."
  fi
done

# ── Step 8: ArgoCD ────────────────────────────────────────────────────────────
if ! $SKIP_GITOPS; then
  log "Step 8: Installing ArgoCD..."
  helm repo add argo https://argoproj.github.io/argo-helm 2>/dev/null || true
  helm repo update

  helm upgrade --install argocd argo/argo-cd \
    --namespace argocd \
    --create-namespace \
    --version 9.5.13 \
    --values "${ROOT_DIR}/local/argocd/argocd-helm-values-local.yaml" \
    --wait --timeout 10m

  ARGOCD_PASS=$(kubectl -n argocd get secret argocd-initial-admin-secret \
    -o jsonpath="{.data.password}" 2>/dev/null | base64 -d || echo "")
  log "ArgoCD installed. UI: http://argocd.idp.local  (admin / ${ARGOCD_PASS:-'not yet available'})"

  if [[ -n "$ARGOCD_PASS" ]]; then
    local_env="${ROOT_DIR}/local/backstage/.env"
    if grep -q "^ARGOCD_AUTH_TOKEN=" "$local_env" 2>/dev/null; then
      sed -i.bak "s|^ARGOCD_AUTH_TOKEN=.*|ARGOCD_AUTH_TOKEN=${ARGOCD_PASS}|" "$local_env" && rm -f "${local_env}.bak"
    else
      echo "ARGOCD_AUTH_TOKEN=${ARGOCD_PASS}" >> "$local_env"
    fi
    log "  ArgoCD token written to local/backstage/.env (ARGOCD_AUTH_TOKEN)"
  fi

  # Register GitHub credentials so ArgoCD can read the private platform repo.
  # Reads GITHUB_TOKEN and GITHUB_ORG from local/.env (set by setup.sh).
  _github_token=$(grep -E '^GITHUB_TOKEN=' "${ROOT_DIR}/local/.env" | cut -d= -f2- | tr -d '"' || true)
  _github_org=$(grep -E '^GITHUB_ORG=' "${ROOT_DIR}/local/.env" | cut -d= -f2- | tr -d '"' || true)
  if [[ -n "$_github_token" && -n "$_github_org" && "$_github_org" != "YOUR_GITHUB_ORG" ]]; then
    kubectl create secret generic argocd-github-creds \
      -n argocd \
      --from-literal=type=git \
      --from-literal=url="https://github.com/${_github_org}" \
      --from-literal=username="${_github_org}" \
      --from-literal=password="${_github_token}" \
      --dry-run=client -o yaml \
      | kubectl label --local -f - "argocd.argoproj.io/secret-type=repo-creds" --dry-run=client -o yaml \
      | kubectl apply -f -
    log "  ArgoCD GitHub credentials registered for https://github.com/${_github_org}"
  else
    warn "  GITHUB_TOKEN or GITHUB_ORG not set in local/.env — ArgoCD will not be able to read private repos."
    warn "  Set both and re-run, or create the secret manually:"
    warn "  kubectl create secret generic argocd-github-creds -n argocd \\"
    warn "    --from-literal=type=git --from-literal=url=https://github.com/<org> \\"
    warn "    --from-literal=username=<org> --from-literal=password=<token>"
    warn "  kubectl label secret argocd-github-creds -n argocd argocd.argoproj.io/secret-type=repo-creds"
  fi
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

# ── Step 10: DORA Exporter (Pushgateway) ─────────────────────────────────────
if ! $SKIP_DORA; then
  if ! $SKIP_OBS; then
    log "Step 10: Installing Prometheus Pushgateway (separate release)..."
    helm upgrade --install prometheus-pushgateway prometheus-community/prometheus-pushgateway \
      --namespace monitoring \
      --set resources.requests.cpu=10m \
      --set resources.requests.memory=32Mi \
      --set resources.limits.cpu=100m \
      --set resources.limits.memory=64Mi \
      --set serviceMonitor.enabled=true \
      --set serviceMonitor.additionalLabels.release=prometheus \
      --set "extraArgs[0]=--web.enable-admin-api" \
      --wait --timeout 5m

    kubectl apply -f "${ROOT_DIR}/local/observability/pushgateway-ingress.yaml"
    log "Pushgateway ingress: http://pushgateway.idp.local"

    log "  Wiping stale Pushgateway metrics for a clean slate..."
    kubectl rollout status deployment/prometheus-pushgateway -n monitoring --timeout=60s
    if ! kubectl exec -n monitoring deploy/prometheus-pushgateway -- \
        wget -q -O- --method=DELETE http://localhost:9091/api/v1/admin/wipe 2>/dev/null; then
      warn "  Pushgateway admin wipe failed — restarting pod to clear in-memory state."
      kubectl rollout restart deployment/prometheus-pushgateway -n monitoring
      kubectl rollout status deployment/prometheus-pushgateway -n monitoring --timeout=60s
    fi
    log "  Pushgateway reset complete."
  fi

  log "Step 10b: Applying DORA exporter (Pushgateway variant)..."
  # Prefer shell-env GITHUB_TOKEN; fall back to local/.env so bootstrap is
  # idempotent without needing the caller to export the variable first.
  _dora_token="${GITHUB_TOKEN:-}"
  if [[ -z "$_dora_token" ]]; then
    _dora_token=$(grep -E '^GITHUB_TOKEN=' "${ROOT_DIR}/local/.env" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
  fi
  if [[ -n "$_dora_token" ]]; then
    kubectl create secret generic dora-exporter-secret \
      --from-literal=GITHUB_TOKEN="${_dora_token}" \
      -n monitoring \
      --dry-run=client -o yaml | kubectl apply -f -
    log "  dora-exporter-secret populated from local/.env."
  else
    warn "GITHUB_TOKEN not set in environment or local/.env — DORA exporter will fail."
    warn "Add GITHUB_TOKEN=<your-pat> to local/.env and re-run bootstrap."
  fi

  kubectl create configmap dora-exporter-script \
    --from-file=dora-exporter.py="${ROOT_DIR}/observability/dora/dora-exporter-local.py" \
    -n monitoring --dry-run=client -o yaml | kubectl apply -f -

  kubectl apply -f "${ROOT_DIR}/observability/dora/dora-cronjob-local.yaml"
  log "DORA exporter deployed (pushes to Prometheus Pushgateway every 15m)."

  log "  Triggering immediate DORA exporter run (seed data without waiting 15m)..."
  kubectl create job "dora-exporter-init-$(date +%s)" \
    --from=cronjob/dora-exporter \
    -n monitoring \
    --dry-run=client -o yaml | kubectl apply -f - || \
    warn "  Could not trigger immediate DORA job — data will appear after first scheduled run."

  # ── Step 10c: Catalog exporter CronJob ─────────────────────────────────────
  if ! $SKIP_OBS; then
    log "Step 10c: Deploying Backstage catalog exporter CronJob..."
    "${ROOT_DIR}/scripts/apply-catalog-exporter.sh"
    log "  Catalog exporter deployed (pushes entity counts to Pushgateway every 15m)."

    log "  Triggering immediate catalog exporter run (seed data without waiting 15m)..."
    CATALOG_CRONJOB=$(kubectl get cronjobs -n monitoring -o jsonpath='{.items[?(@.metadata.name!="dora-exporter")].metadata.name}' 2>/dev/null | tr ' ' '\n' | head -1)
    if [[ -n "$CATALOG_CRONJOB" ]]; then
      kubectl create job "catalog-exporter-init-$(date +%s)" \
        --from="cronjob/${CATALOG_CRONJOB}" \
        -n monitoring \
        --dry-run=client -o yaml | kubectl apply -f - || \
        warn "  Could not trigger immediate catalog job — data will appear after first scheduled run."
    else
      warn "  Could not detect catalog exporter cronjob name — data will appear after first scheduled run."
    fi
  fi
else
  log "Step 10: Skipping DORA exporter (--skip-dora)."
fi

# ── Step 11: Tech Insights Exporter ──────────────────────────────────────────
if ! $SKIP_OBS; then
  log "Step 11: Deploying Tech Insights Exporter CronJob..."
  kubectl create configmap tech-insights-exporter-script \
    --from-file=exporter.py="${ROOT_DIR}/observability/tech-insights-exporter/exporter.py" \
    -n monitoring --dry-run=client -o yaml | kubectl apply -f -
  kubectl apply -f "${ROOT_DIR}/observability/tech-insights-exporter/cronjob.yaml"
  log "  Tech Insights Exporter deployed (pushes scorecard metrics every 15m)."
else
  log "Step 11: Skipping Tech Insights Exporter (--skip-obs)."
fi

# ── Step 12: AlertManager Slack webhook ───────────────────────────────────────
log "Step 12: Wiring AlertManager..."
# Prefer shell-env SLACK_WEBHOOK_URL; fall back to local/.env
if [[ -z "${SLACK_WEBHOOK_URL:-}" ]]; then
  SLACK_WEBHOOK_URL=$(grep -E '^SLACK_WEBHOOK_URL=' "${ROOT_DIR}/local/.env" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
fi
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

# ── Step 7: /etc/hosts ───────────────────────────────────────────────────────
HOSTS_FILE="${ROOT_DIR}/local/hosts-append.txt"
log "Step 7: Checking /etc/hosts entries..."

# Add any hostname from hosts-append.txt that isn't already present.
# Doing it line-by-line avoids duplicates even when the file has grown.
HOSTS_ADDED=false
while IFS= read -r line; do
  # Skip blank lines and comments
  [[ -z "$line" || "$line" == \#* ]] && continue
  # Extract the hostname (second field)
  hostname=$(awk '{print $2}' <<< "$line")
  [[ -z "$hostname" ]] && continue
  if ! grep -qF "$hostname" /etc/hosts 2>/dev/null; then
    if sudo sh -c "echo '$line' >> /etc/hosts"; then
      log "  Added: $hostname"
      HOSTS_ADDED=true
    else
      warn "  Could not add '$hostname' to /etc/hosts. Add it manually:"
      warn "  echo '$line' | sudo tee -a /etc/hosts"
    fi
  fi
done < "$HOSTS_FILE"

if $HOSTS_ADDED; then
  # Flush DNS cache so curl/browser picks up new entries immediately.
  if [[ "$(uname)" == "Darwin" ]]; then
    sudo dscacheutil -flushcache 2>/dev/null || true
    sudo killall -HUP mDNSResponder 2>/dev/null || true
    log "  macOS DNS cache flushed."
  elif command -v resolvectl &>/dev/null; then
    sudo resolvectl flush-caches 2>/dev/null || true
  fi
  log "  /etc/hosts updated. All *.idp.local hostnames are now resolvable."
else
  log "  /etc/hosts already up to date — no changes needed."
fi

# ── Done ──────────────────────────────────────────────────────────────────────
ARGOCD_PASS=""
if ! $SKIP_GITOPS; then
  ARGOCD_PASS=$(kubectl -n argocd get secret argocd-initial-admin-secret \
    -o jsonpath="{.data.password}" 2>/dev/null | base64 -d || echo "")
fi

echo ""
echo "╔══════════════════════════════════════════════════════════════════╗"
echo "║                  Bootstrap complete!                            ║"
echo "╠══════════════════════════════════════════════════════════════════╣"
echo "║  Service          URL                              Credentials  ║"
echo "╠══════════════════════════════════════════════════════════════════╣"
echo "║  hello-service    http://hello-service.idp.local               ║"
if ! $SKIP_OBS; then
echo "║  Grafana          http://grafana.idp.local          admin/admin ║"
echo "║  Prometheus       http://prometheus.idp.local                   ║"
echo "║  AlertManager     http://alertmanager.idp.local                 ║"
echo "║  Pushgateway      http://pushgateway.idp.local                  ║"
echo "║  OpenCost         http://opencost.idp.local                     ║"
fi
if ! $SKIP_GITOPS; then
if [[ -n "$ARGOCD_PASS" ]]; then
echo "║  ArgoCD           http://argocd.idp.local           admin/${ARGOCD_PASS} ║"
else
echo "║  ArgoCD           http://argocd.idp.local                       ║"
fi
fi
echo "║  Backstage        http://localhost:3000  (start separately ↓)  ║"
echo "╠══════════════════════════════════════════════════════════════════╣"
echo "║  Local registry   localhost:5003                                ║"
echo "╚══════════════════════════════════════════════════════════════════╝"
echo ""
if ! $SKIP_GITOPS && [[ -n "$ARGOCD_PASS" ]]; then
echo "  ArgoCD password:  ${ARGOCD_PASS}"
echo "  (also saved in local/backstage/.env as ARGOCD_AUTH_TOKEN)"
echo ""
echo "  Retrieve any time:"
echo "    kubectl -n argocd get secret argocd-initial-admin-secret \\"
echo "      -o jsonpath='{.data.password}' | base64 -d && echo"
echo ""
fi
echo "  Start Backstage (builds, wires nginx, seeds metrics):"
echo "    ./scripts/bootstrap-local.sh --start-backstage"
echo ""
echo "  Day-2:"
echo "    Scaffold service:  ./scripts/create-service.sh --name my-svc --type nodejs"
echo "    Seed QA metrics:   ./scripts/seed-qa-metrics.sh"
echo "    Teardown:          ./scripts/bootstrap-local.sh --destroy"
echo ""
