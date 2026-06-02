#!/usr/bin/env bash
# recover-docker-restart.sh — Recover the local Kind IDP platform after a Docker restart.
#
# Docker restart shuffles container IP addresses, which breaks:
#   - kubelet on control-plane (stale API server IP in kubelet.conf)
#   - kindnet cross-node routes (old IPs baked into route table)
#   - ingress-nginx (stale veth/iptables state)
#   - Grafana PVC permissions (mode-700 subdirs block init container chown)
#   - Prometheus operator (liveness probe kills pod before slow API init completes)
#
# Usage:
#   ./scripts/recover-docker-restart.sh
#   ./scripts/recover-docker-restart.sh --skip-backstage   # skip Backstage Docker Compose restart
#   ./scripts/recover-docker-restart.sh --dry-run          # print steps without executing
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "${ROOT_DIR}/scripts/lib.sh"

CLUSTER_NAME="${CLUSTER_NAME:-idp-mvp}"
SKIP_BACKSTAGE=false
DRY_RUN=false

# ── Flags ─────────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-backstage) SKIP_BACKSTAGE=true; shift ;;
    --dry-run)        DRY_RUN=true;        shift ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

run() {
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [dry-run] $*"
  else
    "$@"
  fi
}

# ── Wait helpers ──────────────────────────────────────────────────────────────
wait_for_node_ready() {
  local node="$1" max="${2:-120}" elapsed=0
  log "Waiting for node $node to become Ready..."
  until kubectl get node "$node" --no-headers 2>/dev/null | grep -q " Ready "; do
    sleep 5; elapsed=$((elapsed+5))
    [[ $elapsed -ge $max ]] && { warn "Node $node not Ready after ${max}s"; return 1; }
  done
  log "Node $node is Ready"
}

wait_for_pods_ready() {
  local ns="$1" label="$2" expected="${3:-1}" max="${4:-120}" elapsed=0
  log "Waiting for pods ($label) in $ns..."
  until [[ "$(kubectl get pods -n "$ns" -l "$label" --no-headers 2>/dev/null | grep -c "Running" || true)" -ge "$expected" ]]; do
    sleep 5; elapsed=$((elapsed+5))
    [[ $elapsed -ge $max ]] && { warn "Pods ($label) in $ns not ready after ${max}s"; return 1; }
  done
}

# ── Pre-flight: Docker must be running and Kind cluster containers must exist ─
step "Pre-flight checks"

if ! docker info &>/dev/null; then
  err "Docker is not running. Start Docker Desktop first."
fi

for node in "${CLUSTER_NAME}-control-plane" "${CLUSTER_NAME}-worker" "${CLUSTER_NAME}-worker2"; do
  if ! docker inspect "$node" &>/dev/null; then
    err "Kind node container '$node' not found. Run ./scripts/bootstrap-local.sh to create the cluster."
  fi
done
log "Docker is running and Kind containers exist"

# ── Step 1: Resolve current container IPs ────────────────────────────────────
step "Step 1 — Detect current container IPs"

get_container_ip() {
  docker inspect "$1" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'
}

CP_IP=$(get_container_ip "${CLUSTER_NAME}-control-plane")
W1_IP=$(get_container_ip "${CLUSTER_NAME}-worker")
W2_IP=$(get_container_ip "${CLUSTER_NAME}-worker2")

log "control-plane: $CP_IP   worker: $W1_IP   worker2: $W2_IP"

# ── Step 2: Fix kubelet.conf on control-plane if the API server IP changed ───
step "Step 2 — Fix kubelet.conf API server IP"

KUBELET_CONF="/etc/kubernetes/kubelet.conf"
CURRENT_SERVER=$(docker exec "${CLUSTER_NAME}-control-plane" \
  grep "server:" "$KUBELET_CONF" | awk '{print $2}' | head -1)
EXPECTED_SERVER="https://${CP_IP}:6443"

if [[ "$CURRENT_SERVER" != "$EXPECTED_SERVER" ]]; then
  log "Updating kubelet.conf: $CURRENT_SERVER → $EXPECTED_SERVER"
  OLD_IP=$(echo "$CURRENT_SERVER" | sed 's|https://\(.*\):6443|\1|')
  run docker exec "${CLUSTER_NAME}-control-plane" \
    sed -i "s|https://${OLD_IP}:6443|${EXPECTED_SERVER}|g" "$KUBELET_CONF"
  run docker exec "${CLUSTER_NAME}-control-plane" systemctl restart kubelet
  wait_for_node_ready "${CLUSTER_NAME}-control-plane"
else
  log "kubelet.conf already correct ($CURRENT_SERVER)"
fi

# Ensure all nodes are Ready before proceeding
for node_name in "${CLUSTER_NAME}-control-plane" "${CLUSTER_NAME}-worker" "${CLUSTER_NAME}-worker2"; do
  wait_for_node_ready "$node_name" 60
done

# ── Step 3: Restart kindnet to re-establish cross-node routes ─────────────────
step "Step 3 — Restart kindnet (cross-node routing)"

STALE=$(kubectl get pods -n kube-system -l app=kindnet -o wide --no-headers 2>/dev/null | \
  awk -v cp_ip="$CP_IP" '$6 != cp_ip && $7 == ENVIRON["CLUSTER_NAME"] "-control-plane" {print "stale"}' || true)

# Always restart — it's idempotent and fast
run kubectl rollout restart daemonset -n kube-system kindnet

log "Waiting for kindnet pods to be ready..."
elapsed=0
until kubectl get pods -n kube-system -l app=kindnet --no-headers 2>/dev/null \
    | grep -v "Running" | grep -qv "^$" || \
    [[ $(kubectl get pods -n kube-system -l app=kindnet --no-headers 2>/dev/null | grep -c "Running" || echo 0) -eq 3 ]]; do
  sleep 3; elapsed=$((elapsed+3))
  [[ $elapsed -ge 60 ]] && { warn "kindnet pods not all running after 60s"; break; }
done
kubectl get pods -n kube-system -l app=kindnet -o wide 2>/dev/null || true

# ── Step 4: Restart kube-proxy ────────────────────────────────────────────────
step "Step 4 — Restart kube-proxy (iptables rules)"

run kubectl rollout restart daemonset -n kube-system kube-proxy
elapsed=0
until [[ $(kubectl get pods -n kube-system -l k8s-app=kube-proxy --no-headers 2>/dev/null | grep -c "Running" || echo 0) -eq 3 ]]; do
  sleep 3; elapsed=$((elapsed+3))
  [[ $elapsed -ge 60 ]] && { warn "kube-proxy pods not all running after 60s"; break; }
done

# ── Step 5: Restart ingress-nginx controller ──────────────────────────────────
step "Step 5 — Restart ingress-nginx (clear stale veth/iptables)"

# Delete the existing pod directly — the deployment uses hostPorts 80/443 so a
# rolling update cannot schedule the new pod until the old one is gone.
OLD_INGRESS_POD=$(kubectl get pods -n ingress-nginx -l "app.kubernetes.io/component=controller" \
  --no-headers 2>/dev/null | awk '{print $1}' | head -1 || true)

if [[ -n "$OLD_INGRESS_POD" ]]; then
  run kubectl delete pod -n ingress-nginx "$OLD_INGRESS_POD" --grace-period=5
fi

log "Waiting for ingress-nginx controller to be ready..."
elapsed=0
until kubectl get pods -n ingress-nginx -l "app.kubernetes.io/component=controller" \
    --no-headers 2>/dev/null | grep -q "1/1.*Running"; do
  sleep 5; elapsed=$((elapsed+5))
  [[ $elapsed -ge 90 ]] && { warn "ingress-nginx not ready after 90s"; break; }
done

# ── Step 6: Fix Grafana PVC permissions ───────────────────────────────────────
step "Step 6 — Fix Grafana PVC permissions"

GRAFANA_PVC=$(kubectl get pvc -n monitoring prometheus-grafana \
  -o jsonpath='{.spec.volumeName}' 2>/dev/null || true)

if [[ -n "$GRAFANA_PVC" ]]; then
  # Find which worker node hosts the local-path PV
  PV_PATH="/var/local-path-provisioner/${GRAFANA_PVC}_monitoring_prometheus-grafana"
  for worker in "${CLUSTER_NAME}-worker" "${CLUSTER_NAME}-worker2"; do
    if docker exec "$worker" test -d "$PV_PATH" 2>/dev/null; then
      log "Fixing Grafana PV permissions on $worker: $PV_PATH"
      run docker exec "$worker" chmod -R 755 \
        "${PV_PATH}/csv" "${PV_PATH}/pdf" "${PV_PATH}/png" 2>/dev/null || true
      break
    fi
  done

  # Delete stuck/Unknown Grafana pod so it restarts cleanly
  GRAFANA_POD=$(kubectl get pods -n monitoring -l "app.kubernetes.io/name=grafana" \
    --no-headers 2>/dev/null | grep -v "Running" | awk '{print $1}' | head -1 || true)
  if [[ -n "$GRAFANA_POD" ]]; then
    log "Deleting stuck Grafana pod: $GRAFANA_POD"
    run kubectl delete pod -n monitoring "$GRAFANA_POD" --force --grace-period=0 2>/dev/null || true
  fi
else
  log "Grafana PVC not found — skipping"
fi

# ── Step 7: Fix Prometheus operator liveness probe ────────────────────────────
step "Step 7 — Fix Prometheus operator liveness probe"

# After Docker restart the API server is slow to respond (~24s for capabilities
# check). The default liveness probe has initialDelaySeconds=0 and kills the
# operator before it can start its HTTPS server. Patch to 120s once.
CURRENT_DELAY=$(kubectl get deployment -n monitoring prometheus-kube-prometheus-operator \
  -o jsonpath='{.spec.template.spec.containers[0].livenessProbe.initialDelaySeconds}' \
  2>/dev/null || echo "0")

if [[ "${CURRENT_DELAY:-0}" -lt 60 ]]; then
  log "Patching Prometheus operator liveness probe: initialDelaySeconds=120"
  run kubectl patch deployment -n monitoring prometheus-kube-prometheus-operator \
    --type='json' \
    -p='[
      {"op":"replace","path":"/spec/template/spec/containers/0/livenessProbe/initialDelaySeconds","value":120},
      {"op":"replace","path":"/spec/template/spec/containers/0/readinessProbe/initialDelaySeconds","value":60}
    ]' 2>/dev/null || true
else
  log "Prometheus operator probe already patched (initialDelaySeconds=$CURRENT_DELAY)"
fi

# Delete any stuck monitoring pods (Unknown/CrashLoopBackOff from before Docker restart)
STUCK_PODS=$(kubectl get pods -n monitoring --no-headers 2>/dev/null | \
  grep -E "Unknown|CrashLoopBackOff|Error" | awk '{print $1}' || true)
for pod in $STUCK_PODS; do
  log "Deleting stuck monitoring pod: $pod"
  run kubectl delete pod -n monitoring "$pod" --force --grace-period=0 2>/dev/null || true
done

# ── Step 8: Restart Backstage Docker Compose ──────────────────────────────────
if [[ "$SKIP_BACKSTAGE" == "false" ]]; then
  step "Step 8 — Restart Backstage (Docker Compose)"
  COMPOSE_FILE="${ROOT_DIR}/local/backstage/docker-compose.yml"
  if [[ -f "$COMPOSE_FILE" ]]; then
    run docker compose -f "$COMPOSE_FILE" restart
    log "Backstage restarted"
  else
    warn "Docker Compose file not found: $COMPOSE_FILE"
  fi
else
  log "Step 8 — Skipping Backstage restart (--skip-backstage)"
fi

# ── Step 9: Wait for platform to stabilise ───────────────────────────────────
step "Step 9 — Waiting for platform to stabilise"

wait_for_pods_ready "argocd"      "app.kubernetes.io/name=argocd-server"        1 90
wait_for_pods_ready "monitoring"  "app.kubernetes.io/name=grafana"              1 90
wait_for_pods_ready "monitoring"  "app=kube-prometheus-stack-operator"          1 180
wait_for_pods_ready "kagent"      "app.kubernetes.io/component=ui"              1 60
wait_for_pods_ready "ml-platform" "app=mlflow"                                  1 60
wait_for_pods_ready "services-dev" "app.kubernetes.io/instance=hello-service-local" 1 60

# ── Step 10: Smoke-test all service URLs ─────────────────────────────────────
step "Step 10 — Smoke testing service URLs"

PASS=0; FAIL=0
check_url() {
  local url="$1" name="$2"
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$url" 2>/dev/null || echo "000")
  if [[ "$code" =~ ^(200|301|302|307|308)$ ]]; then
    log "  ✓ $name ($url) → $code"
    PASS=$((PASS+1))
  else
    warn "  ✗ $name ($url) → $code"
    FAIL=$((FAIL+1))
  fi
}

check_url "http://backstage.idp.local"        "Backstage"
check_url "http://argocd.idp.local"           "ArgoCD"
check_url "http://grafana.idp.local"          "Grafana"
check_url "http://prometheus.idp.local"       "Prometheus"
check_url "http://pushgateway.idp.local"      "Pushgateway"
check_url "http://hello-service.idp.local"    "hello-service"
check_url "http://kagent.idp.local"           "KAgent UI"
check_url "http://mlflow.idp.local"           "MLflow"
check_url "http://opencost.idp.local"         "OpenCost"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Recovery complete: ${PASS} passing, ${FAIL} failing"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [[ $FAIL -gt 0 ]]; then
  warn "$FAIL service(s) did not respond as expected — they may still be starting."
  warn "Re-run this script in a minute, or check: kubectl get pods -A"
  exit 1
fi
