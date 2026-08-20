#!/usr/bin/env bash
# bootstrap-local.sh — Set up the full IDP MVP locally using Kind or Rancher Desktop.
# No AWS account needed. Mirrors the cloud setup with nginx + Prometheus.
#
# Usage:
#   ./scripts/bootstrap-local.sh                              # Kind (default): cluster + platform
#   ./scripts/bootstrap-local.sh --full                       # cluster + platform + Backstage in one shot
#   ./scripts/bootstrap-local.sh --provider rancher-desktop   # Rancher Desktop k3s
#   ./scripts/bootstrap-local.sh --skip-obs                   # skip observability (faster)
#   ./scripts/bootstrap-local.sh --start-backstage            # Backstage only (cluster already up)
#   ./scripts/bootstrap-local.sh --install-pushgateway        # install/fix Pushgateway + seed QA metrics
#   ./scripts/bootstrap-local.sh --install-argocd             # install/fix ArgoCD + register GitHub creds
#   ./scripts/bootstrap-local.sh --install-argo-workflows     # install Argo Workflows for ML pipeline orchestration
#   ./scripts/bootstrap-local.sh --update-backstage-ip        # refresh Backstage endpoint IP after compose up
#   ./scripts/bootstrap-local.sh --destroy                    # tear everything down (prompts for confirmation)
#   ./scripts/bootstrap-local.sh --clean-docker               # stop Backstage + prune all Docker resources
#   ./scripts/bootstrap-local.sh --print-urls                 # print all service URLs without running bootstrap
#
# Rancher Desktop prerequisites (one-time):
#   1. Preferences → Kubernetes → disable Traefik  (nginx-ingress uses ports 80/443)
#   2. Preferences → Container Engine → set to dockerd
#   3. Set KUBERNETES_PROVIDER=rancher-desktop in local/.env (or pass --provider each time)
#
# Scope: cluster creation, ingress, observability, ArgoCD, OPA, DORA exporter,
#        K8s credentials (local/backstage/.env), and catalog exporter CronJob.
# Called by setup.sh (first-time) and usable standalone for day-2 cluster recreates.
set -euo pipefail

# Resolved once here so every step and the early-exit paths can use it.
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# shellcheck source=scripts/lib.sh
source "${ROOT_DIR}/scripts/lib.sh"

# Per-step wall-clock timings, printed as a slowest-first table on exit
# (including on failure). Set IDP_TIMING=0 to silence, IDP_FORCE=1 to bypass
# every skip-if-unchanged check and reinstall/rebuild everything.
timer_enable_summary

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
RUN_BACKSTAGE_AFTER=false
INSTALL_PUSHGATEWAY=false
INSTALL_ARGOCD=false
INSTALL_ARGO_WORKFLOWS=false
PRINT_URLS=false
# Read provider from env first; CLI --provider flag overrides below.
PROVIDER="${KUBERNETES_PROVIDER:-kind}"

# ── Apply personalisation from .idp-config.env or local/.env ─────────────────
# Day-2 re-runs read the single-source-of-truth file written by setup.sh and
# re-apply any YOUR_* placeholders that may have crept back in (e.g. after
# `git pull`). Manifest-driven — adding a row to placeholders.conf is enough.
_apply_personalization() {
  load_idp_config   # sources .idp-config.env into the shell if present

  # Fallback: legacy local/.env (covers users who upgraded before setup.sh ran)
  if [[ -z "${GITHUB_ORG:-}" ]]; then
    local env_file="${ROOT_DIR}/local/.env"
    if [[ -f "$env_file" ]]; then
      GITHUB_ORG=$(grep -E '^GITHUB_ORG=' "$env_file" | cut -d= -f2- | tr -d '"' || true)
      PLATFORM_REPO=$(grep -E '^PLATFORM_REPO=' "$env_file" | cut -d= -f2- | tr -d '"' || true)
    fi
  fi

  if [[ -z "${GITHUB_ORG:-}" || "${GITHUB_ORG}" == "YOUR_GITHUB_ORG" ]]; then
    warn "GITHUB_ORG not set (no .idp-config.env or local/.env) — skipping placeholder substitution."
    warn "Run ./scripts/setup.sh first."
    return
  fi

  load_placeholder_manifest   # populates MANIFEST_* arrays
  run_personalization_pass    # shared with setup.sh — see scripts/lib.sh
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
    --full)                RUN_BACKSTAGE_AFTER=true;   shift ;;
    --start-backstage)     START_BACKSTAGE=true;       shift ;;
    --install-pushgateway) INSTALL_PUSHGATEWAY=true;   shift ;;
    --install-argocd)      INSTALL_ARGOCD=true;        shift ;;
    --install-argo-workflows) INSTALL_ARGO_WORKFLOWS=true; shift ;;
    --provider)            PROVIDER="$2";              shift 2 ;;
    --print-urls)          PRINT_URLS=true;            shift ;;
    *) err "Unknown flag: $1" ;;
  esac
done

# Compose file(s) — Rancher Desktop override drops the 'kind' external network.
_COMPOSE_BASE="${ROOT_DIR}/local/backstage/docker-compose.yml"
_COMPOSE_RANCHER="${ROOT_DIR}/local/backstage/docker-compose.rancher.yml"
if [[ "$PROVIDER" == "rancher-desktop" ]]; then
  COMPOSE_CMD="docker compose -f ${_COMPOSE_BASE} -f ${_COMPOSE_RANCHER}"
else
  COMPOSE_CMD="docker compose -f ${_COMPOSE_BASE}"
fi

# ── Docker deep-clean helper ──────────────────────────────────────────────────
# Reclaim every byte of IDP-related Docker state. This is what `--clean-docker`
# is for, and it stays deliberately aggressive — reclaiming disk IS its purpose.
#
# `--destroy` used to call this too. It no longer does; see _teardown_docker.
_clean_docker() {
  log "Stopping Backstage Docker Compose stack..."
  ${COMPOSE_CMD} \
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

# Teardown for `--destroy`: remove the cluster's own state, keep the caches that
# only make the next bootstrap slower to rebuild.
#
# This used to be _clean_docker, and that cost about a quarter of an hour every
# time. Measured 2026-08-20: a cold bootstrap after the old teardown took 18m52s,
# and every one of its slowest steps was dominated by re-pulling upstream chart
# images that `docker image prune -a` had just deleted —
#
#   5. Prometheus + Grafana  7m22s     8. ArgoCD                1m53s
#   2. Kind cluster          3m16s     9. Gatekeeper + Kyverno  1m48s
#   5b-5d OpenCost/Loki/...  2m10s     4. Ingress               1m29s
#
# — while `6. Images (join)` was 0s, i.e. the images this repo builds were never
# on the critical path at all. The prune took Docker from 20.32GB to 0 and bought
# nothing that `--clean-docker` does not already offer on demand.
#
# What is still removed: the Kind cluster (by the caller), the compose stack and
# its volumes — Backstage's Postgres data belongs to the cluster being destroyed
# and must not outlive it.
#
# What is kept: upstream images, the buildx cache, and the local registry
# container with the images this repo built. The registry is not cluster-specific;
# the next bootstrap finds it running and reconnects it to the new kind network.
_teardown_docker() {
  log "Stopping Backstage Docker Compose stack (keeping its image)..."
  # No --rmi all: the Backstage image is expensive to rebuild (its Dockerfile
  # calls the yarn layer "the 8-minute install layer") and is not cluster state.
  ${COMPOSE_CMD} \
    down --volumes --remove-orphans 2>/dev/null || true

  log "Keeping the local registry, image cache and build cache for the next bootstrap."
  log "  Reclaim them with: ./scripts/bootstrap-local.sh --clean-docker"
}

# kubectl apply, but when the failure is an admission webhook refusing the
# request, say what that means and how to get out of it. The raw error is a wall
# of Go error text ending in "connection refused", which reads like a network
# problem rather than "your policy engine is down and is now blocking its own
# repair".
_apply_or_explain() {
  local manifest="$1" out rc
  out=$(kubectl apply -f "$manifest" 2>&1); rc=$?
  [[ -n "$out" ]] && printf '%s\n' "$out"
  (( rc == 0 )) && return 0

  if grep -qE 'failed calling webhook|admission webhook .* denied' <<< "$out"; then
    local hook
    hook=$(grep -oE 'webhook "[^"]+"' <<< "$out" | head -1 | cut -d'"' -f2)
    # Deliberately not err(): that exits immediately, which would swallow every
    # line of guidance below. The non-zero return propagates under `set -e`.
    warn "Applying $(basename "$manifest") was rejected by admission webhook '${hook:-unknown}'."
    warn "  A fail-closed webhook whose backend is unhealthy blocks this apply, and"
    warn "  therefore blocks the bootstrap that would repair it."
    warn ""
    warn "  Check the policy engines:"
    warn "    kubectl -n kyverno get pods"
    warn "    kubectl -n gatekeeper-system get pods"
    warn ""
    warn "  If pods are crashlooping, they are usually starved rather than broken —"
    warn "  free CPU/memory on the host and let them settle, then re-run."
    warn "  To inspect what is fail-closed:"
    warn "    kubectl get validatingwebhookconfiguration -o custom-columns=\\"
    warn "      NAME:.metadata.name,POLICY:.webhooks[*].failurePolicy"
  fi
  return "$rc"
}

# One row of the URL banner, padded to the box's 77-character interior. The
# AI/ML rows used to be hand-padded and sat 2 characters short of every other
# row, so the right-hand border was visibly ragged.
_box_row() {
  local text="$1" chars bytes
  # printf pads by BYTES, but the banner contains multibyte characters (the em
  # dash in the title), so a plain %-73s renders those rows short and leaves the
  # right border ragged. Widen the pad by the byte/character difference.
  chars=${#text}
  bytes=$(LC_ALL=C printf '%s' "$text" | wc -c)
  printf '║  %-*s║\n' "$(( 73 + bytes - chars ))" "$text"
}

# ── URL banner helper (used by --print-urls and the final Done section) ───────
_print_url_banner() {
  local argocd_pass=""
  argocd_pass=$(kubectl -n argocd get secret argocd-initial-admin-secret \
    -o jsonpath="{.data.password}" 2>/dev/null | base64 -d || echo "")

  echo ""
  echo "╔═══════════════════════════════════════════════════════════════════════════╗"
  # Centred via the same helper as every other row, so the border stays flush.
  _box_row "                  IDP Platform — Service URLs"
  echo "╠═══════════════════════════════════════════════════════════════════════════╣"
  echo "║  Core Platform                                                            ║"
  _box_row "Backstage        http://backstage.idp.local"
  _box_row "hello-service    http://hello-service.idp.local"
  if kubectl get svc argocd-server -n argocd &>/dev/null 2>&1; then
    if [[ -n "$argocd_pass" ]]; then
  _box_row "ArgoCD           http://argocd.idp.local          admin/${argocd_pass}"
    else
  _box_row "ArgoCD           http://argocd.idp.local"
    fi
  fi
  # Both gate on the workload, not the namespace: `helm uninstall` leaves the
  # namespace behind, and a namespace check would then keep advertising a URL
  # that 404s. (This is the same trap the AI/ML section fell into below, where
  # namespaces.yaml pre-creates `kagent` on every run.)
  if kubectl -n argo-rollouts get deploy -o name 2>/dev/null | grep -q .; then
  _box_row "Argo Rollouts    http://argo-rollouts.idp.local"
  fi
  if kubectl -n argo-workflows get deploy argo-workflows-server &>/dev/null 2>&1; then
  _box_row "Argo Workflows   http://argo-workflows.idp.local"
  fi
  echo "╠═══════════════════════════════════════════════════════════════════════════╣"
  echo "║  Observability                                                            ║"
  echo "║  Grafana          http://grafana.idp.local         admin/admin            ║"
  echo "║  Prometheus       http://prometheus.idp.local                             ║"
  echo "║  AlertManager     http://alertmanager.idp.local                           ║"
  echo "║  Pushgateway      http://pushgateway.idp.local                            ║"
  # Tempo and Loki ship scaled to 0 on this node (capacity — see
  # local/observability/tempo/tempo-values.yaml). Only advertise the trace/log
  # endpoints when something is actually serving them, so the banner never
  # points at a dead URL.
  if [[ "$(kubectl -n monitoring get sts tempo -o jsonpath='{.spec.replicas}' 2>/dev/null || echo 0)" != "0" ]]; then
  echo "║  Traces (Tempo)   http://grafana.idp.local/explore  → pick 'Tempo'        ║"
  echo "║    └ OTLP ingest  tempo.idp.local/v1/traces  (POST only — no browser UI)  ║"
  fi
  if [[ "$(kubectl -n monitoring get sts loki -o jsonpath='{.spec.replicas}' 2>/dev/null || echo 0)" != "0" ]]; then
  echo "║  Logs (Loki)      http://grafana.idp.local/explore  → pick 'Loki'         ║"
  fi
  echo "║  OpenCost         http://opencost.idp.local                               ║"
  echo "╠═══════════════════════════════════════════════════════════════════════════╣"
  # Advertise what is actually deployed, not what a namespace's existence
  # implies. This used to gate on `kubectl get ns kagent`, but
  # kubernetes/namespaces/namespaces.yaml creates the kagent namespace at Step 3
  # of *every* bootstrap-local run — so the check was true on a cluster where
  # bootstrap-ai.sh had never run, and the banner then advertised a KAgent UI and
  # an MLflow that did not exist. It also hardcoded three MCP servers when there
  # are eight.
  #
  # The MCP servers are a genuinely different case: ArgoCD deploys everything
  # under services/* on every run, so they really are up and listing them is
  # correct. They are discovered rather than hardcoded so the list cannot go
  # stale again.
  _ai_rows=(); _ai_n=0
  if kubectl -n kagent get deploy -o name 2>/dev/null | grep -q .; then
    _ai_rows+=("KAgent UI|http://kagent.idp.local"); _ai_n=$((_ai_n + 1))
    _ai_rows+=("AI Assistant|http://backstage.idp.local/ai-assistant"); _ai_n=$((_ai_n + 1))
  fi
  if kubectl -n ml-platform get deploy -o name 2>/dev/null | grep -q mlflow; then
    _ai_rows+=("MLflow|http://mlflow.idp.local"); _ai_n=$((_ai_n + 1))
  fi
  while read -r _dep; do
    [[ -z "$_dep" ]] && continue
    _dep="${_dep#deployment.apps/}"
    _ai_rows+=("${_dep}|http://${_dep}.idp.local/healthz"); _ai_n=$((_ai_n + 1))
  done < <(kubectl -n services-dev get deploy -o name 2>/dev/null | grep -- '-mcp-server$' | sort)

  if (( _ai_n > 0 )); then
  _box_row "AI / ML Platform"
  for _row in ${_ai_rows[@]+"${_ai_rows[@]}"}; do
    _box_row "$(printf '%-21s %s' "${_row%%|*}" "${_row#*|}")"
  done
  echo "╠═══════════════════════════════════════════════════════════════════════════╣"
  fi
  # Say what is deliberately absent. Every section above hides components that
  # are not deployed, which is correct but indistinguishable from something
  # having gone wrong — the question "why is Argo Workflows not in the list?"
  # has no answer anywhere in this output otherwise.
  _optional=()
  kubectl -n argo-workflows get deploy argo-workflows-server &>/dev/null 2>&1 \
    || _optional+=("Argo Workflows (--install-argo-workflows)")
  kubectl -n kagent get deploy -o name 2>/dev/null | grep -q . \
    || _optional+=("KAgent + MLflow (./scripts/bootstrap-ai.sh)")
  # No leading separator: one is always printed immediately above this point,
  # either by the Observability section or by the AI/ML section's trailer.
  if (( ${#_optional[@]} > 0 )); then
  _box_row "Available, not installed"
  for _opt in ${_optional[@]+"${_optional[@]}"}; do
  _box_row "  ${_opt}"
  done
  echo "╠═══════════════════════════════════════════════════════════════════════════╣"
  fi
  _box_row "Local registry   localhost:5003"
  echo "╚═══════════════════════════════════════════════════════════════════════════╝"
  echo ""
  if [[ -n "$argocd_pass" ]]; then
  echo "  ArgoCD admin password: ${argocd_pass}"
  echo "  (saved in local/backstage/.env as ARGOCD_AUTH_TOKEN)"
  echo ""
  fi
  echo "  Next steps:"
  echo "    Start Backstage:   ./scripts/bootstrap-local.sh --start-backstage"
  if ! kubectl get ns kagent &>/dev/null 2>&1; then
  echo "    Install AI/ML:     ./scripts/bootstrap-ai.sh"
  fi
  echo "    Scaffold service:  ./bin/idp scaffold service --name my-svc --type nodejs"
  echo "    Print URLs again:  ./scripts/bootstrap-local.sh --print-urls"
  echo "    Teardown:          ./scripts/bootstrap-local.sh --destroy"
  echo ""
}

# ── --clean-docker fast path ──────────────────────────────────────────────────
if ${CLEAN_DOCKER:-false}; then
  _clean_docker
  exit 0
fi

# ── --print-urls fast path ────────────────────────────────────────────────────
if $PRINT_URLS; then
  _print_url_banner
  exit 0
fi

# ── --install-argocd fast path ────────────────────────────────────────────────
if $INSTALL_ARGOCD; then
  log "Installing / repairing ArgoCD..."
  ensure_helm_repos argo
  helm upgrade --install argocd argo/argo-cd \
    --namespace argocd \
    --create-namespace \
    --version 9.5.13 \
    --values "${ROOT_DIR}/local/argocd/argocd-helm-values-local.yaml" \
    --wait --timeout "${HELM_WAIT_MED}"
  helm_record_fingerprint "${ROOT_DIR}/.idp-cache/argocd.fingerprint" \
    "9.5.13:$(_sha256 "${ROOT_DIR}/local/argocd/argocd-helm-values-local.yaml")"

  ARGOCD_PASS=$(kubectl -n argocd get secret argocd-initial-admin-secret \
    -o jsonpath="{.data.password}" 2>/dev/null | base64 -d || echo "")
  log "ArgoCD ready. UI: http://argocd.idp.local  (admin / ${ARGOCD_PASS:-'secret not yet available'})"

  if [[ -n "$ARGOCD_PASS" ]]; then
    # The Backstage proxy sends ARGOCD_AUTH_TOKEN as a Bearer token, which
    # the ArgoCD API server only accepts as a session JWT — not the raw
    # admin password. Exchange the password for a real token via the API.
    ARGOCD_TOKEN=$(curl -s -X POST http://argocd.idp.local/api/v1/session \
      -H "Content-Type: application/json" \
      -d "{\"username\":\"admin\",\"password\":\"${ARGOCD_PASS}\"}" \
      | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
    local_env="${ROOT_DIR}/local/backstage/.env"
    if grep -q "^ARGOCD_AUTH_TOKEN=" "$local_env" 2>/dev/null; then
      sed -i.bak "s|^ARGOCD_AUTH_TOKEN=.*|ARGOCD_AUTH_TOKEN=${ARGOCD_TOKEN}|" "$local_env" && rm -f "${local_env}.bak"
    else
      echo "ARGOCD_AUTH_TOKEN=${ARGOCD_TOKEN}" >> "$local_env"
    fi
    log "  ArgoCD token written to local/backstage/.env"
  fi

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
    log "  GitHub credentials registered for https://github.com/${_github_org}"
  fi

  kubectl apply -f "${ROOT_DIR}/local/argocd/app-of-apps-local.yaml" -n argocd || \
    warn "ApplicationSet apply failed — ArgoCD may need a moment to settle. Retry: kubectl apply -f local/argocd/app-of-apps-local.yaml -n argocd"
  # Belt-and-braces: clear any stale hello-service release from older bootstraps
  # in the 'services' namespace so ArgoCD can manage it in 'services-dev'.
  helm uninstall hello-service -n services 2>/dev/null || true
  exit 0
fi

# ── --install-pushgateway fast path ───────────────────────────────────────────
if $INSTALL_PUSHGATEWAY; then
  log "Installing / repairing Prometheus Pushgateway..."
  helm upgrade --install prometheus-pushgateway prometheus-community/prometheus-pushgateway \
    --namespace monitoring --create-namespace \
    --set resources.requests.cpu=10m \
    --set resources.requests.memory=32Mi \
    --set resources.limits.cpu=100m \
    --set resources.limits.memory=64Mi \
    --set serviceMonitor.enabled=true \
    --set serviceMonitor.additionalLabels.release=prometheus \
    --set "extraArgs[0]=--web.enable-admin-api" \
    --wait --timeout "${HELM_WAIT_SHORT}"
  kubectl apply -f "${ROOT_DIR}/local/observability/pushgateway-ingress.yaml"
  kubectl rollout status deployment/prometheus-pushgateway -n monitoring --timeout=60s
  log "Pushgateway ready. Seeding QA metrics..."
  "${ROOT_DIR}/scripts/seed-qa-metrics.sh"
  log "Done. Grafana → QA Platform Metrics dashboard: http://grafana.idp.local"
  exit 0
fi

# ── Teardown path ─────────────────────────────────────────────────────────────
if $DESTROY; then
  # ── Confirmation guard ────────────────────────────────────────────────────
  echo ""
  warn "This will permanently delete the local IDP cluster, all workloads, the"
  warn "Backstage compose stack and its database, and remove /etc/hosts entries."
  echo ""
  log  "  Kept, so the next bootstrap does not re-pull and rebuild everything:"
  log  "    the local Docker registry, the image cache and the buildx cache."
  log  "    Reclaim that disk with: ./scripts/bootstrap-local.sh --clean-docker"
  echo ""
  read -rp "  Type 'yes' to confirm destroy: " _CONFIRM
  if [[ "$_CONFIRM" != "yes" ]]; then
    log "Aborted — nothing was destroyed."
    exit 0
  fi
  echo ""

  log "Destroying local IDP platform..."

  # ── Tear down AI/ML components first (while cluster is still up) ──────────
  # IMPORTANT: pass no --aws flag so bootstrap-ai.sh destroy only removes local/
  # manifests. Never call this with --aws from a local teardown path.
  if kubectl get namespace kagent ml-platform services-dev &>/dev/null 2>&1; then
    log "AI/ML components detected — running bootstrap-ai.sh --destroy (local only)..."
    bash "${ROOT_DIR}/scripts/bootstrap-ai.sh" --destroy || true
  fi

  # ── Clean up user-scaffolded services before the cluster is deleted ──────────
  log "Cleaning up scaffolded services from ArgoCD, Helm, and git repo..."
  _cleanup_scaffolded_services "local"

  if [[ "$PROVIDER" == "kind" ]]; then
    # Delete the Kind cluster — removes all namespaces, Helm state, and workloads.
    kind delete cluster --name "$CLUSTER_NAME" 2>/dev/null || true
  else
    # Rancher Desktop: delete all platform namespaces (cluster itself stays).
    log "Rancher Desktop: removing platform namespaces (cluster itself is untouched)..."
    kubectl delete namespace \
      services services-dev monitoring argocd ingress-nginx \
      gatekeeper-system opencost kagent ml-platform \
      2>/dev/null || true
  fi

  # The AI overlay is gitignored and lives on disk, so it survives the cluster it
  # describes. bootstrap-ai.sh --destroy resets it, but the call above is guarded
  # on all three of kagent/ml-platform/services-dev existing — so a teardown of a
  # cluster that was already partly gone skipped it entirely and left the overlay
  # asserting `aiStack.enabled: true` with no cluster at all behind it. Reset it
  # here unconditionally: the cluster is being destroyed, so AI is off by
  # definition. Idempotent and cheap. Observed 2026-08-18.
  write_backstage_ai_overlay false
  log "  Backstage AI overlay reset to disabled."

  # ── Stop the compose stack; keep the Docker caches ────────────────────────
  # Deliberately NOT _clean_docker. Destroying a cluster is not a request to
  # reclaim disk, and conflating the two made every rebuild pay a full cold pull
  # of every upstream image. `--clean-docker` remains the way to ask for that.
  _teardown_docker

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

# ── Helper: configure containerd registry mirrors on Kind nodes ───────────────
# Uses the hosts.toml approach (containerd v1 + v2 compatible).
# The old containerdConfigPatches registry.mirrors syntax was removed in containerd v2.
_setup_kind_registry_mirrors() {
  local certs_dir="/etc/containerd/certs.d/localhost:${REGISTRY_PORT}"
  for node in $(kind get nodes --name "$CLUSTER_NAME" 2>/dev/null); do
    # Create hosts.toml mirror entry for this registry
    docker exec "${node}" sh -c "
      mkdir -p '${certs_dir}' &&
      printf '[host.\"http://${REGISTRY_NAME}:5000\"]\n  capabilities = [\"pull\", \"resolve\"]\n' \
        > '${certs_dir}/hosts.toml'
    "

    # Ensure containerd config.toml has config_path pointing to certs.d.
    # Detect containerd major version to choose the right plugin key.
    docker exec "${node}" sh -c '
      if ! grep -q "config_path" /etc/containerd/config.toml 2>/dev/null; then
        ct_major=$(containerd --version 2>/dev/null | sed "s/.*v\([0-9]*\)\..*/\1/")
        if [ "${ct_major:-1}" -ge 2 ]; then
          plugin="io.containerd.cri.v1.images"
        else
          plugin="io.containerd.grpc.v1.cri"
        fi
        printf "\n[plugins.\"%s\".registry]\n  config_path = \"/etc/containerd/certs.d\"\n" \
          "$plugin" >> /etc/containerd/config.toml
      fi
    '

    docker exec "${node}" systemctl restart containerd
    log "  Node ${node}: registry mirror configured."
  done
}

# ── Helper: raise inotify limits on Kind nodes ────────────────────────────────
# Default Docker Desktop limits (128 instances) are too low for a multi-node
# Kind cluster running Backstage + KAgent + ArgoCD + observability. When kube-proxy
# hits "too many open files" it crashes, breaking cross-node Service routing and
# manifesting as 502s in kagent UI and stuck DB migrations in kagent-controller.
#
# Docker Desktop resets these limits every time its Linux VM restarts (i.e. after
# every machine reboot). The privileged Alpine container targets the Docker VM
# kernel directly, which is the only fix that survives VM restarts. The per-node
# exec is belt-and-suspenders for containerd's own watchers inside each node.
_raise_kind_inotify_limits() {
  docker run --rm --privileged alpine sysctl -w \
    fs.inotify.max_user_instances=8192 \
    fs.inotify.max_user_watches=524288 >/dev/null 2>&1 || \
    warn "  Could not raise inotify limits at Docker VM level — kubelet may fail after a machine reboot."
  for node in $(kind get nodes --name "$CLUSTER_NAME" 2>/dev/null); do
    docker exec --privileged "${node}" sysctl -w \
      fs.inotify.max_user_instances=8192 \
      fs.inotify.max_user_watches=524288 >/dev/null 2>&1 || \
      warn "  Node ${node}: failed to raise inotify limits."
  done
  log "  Inotify limits raised (Docker VM + Kind nodes)."
}

# ── Helper: apply Backstage K8s Service, Endpoints, and nginx Ingress ────────
# Auto-detects the live container IP on the 'kind' Docker network so nginx can
# proxy to the Docker Compose Backstage container. Falls back to the hardcoded
# default (172.17.0.1, matching local/backstage/backstage-k8s-endpoints.yaml)
# when the container is not yet running.
apply_backstage_k8s_objects() {
  local endpoints_file="${ROOT_DIR}/local/backstage/backstage-k8s-endpoints.yaml"
  local ingress_file="${ROOT_DIR}/local/backstage/backstage-ingress.yaml"

  local bs_ip
  if [[ "$PROVIDER" == "kind" ]]; then
    bs_ip=$(docker inspect backstage-backstage-1 \
      --format '{{(index .NetworkSettings.Networks "kind").IPAddress}}' 2>/dev/null || true)
  else
    # Rancher Desktop: kube-router iptables rules in the Lima VM block intra-bridge
    # SYN-ACKs, so direct container IPs are unreachable from k3s pods. Use the
    # Docker host gateway (172.17.0.1 = docker0) which proxies exposed ports, and
    # port 3000 is exported on 0.0.0.0 in the compose file.
    bs_ip="172.17.0.1"
  fi

  if [[ -n "$bs_ip" && "$bs_ip" != "<no value>" ]]; then
    log "  Backstage endpoint IP: ${bs_ip}"
    sed "s/ip: \"[0-9.]*\"/ip: \"${bs_ip}\"/" "$endpoints_file" | kubectl apply -f -
  else
    warn "  Backstage container not running — applying with default IP (172.17.0.1)."
    warn "  After 'docker compose up -d', run: ./scripts/bootstrap-local.sh --update-backstage-ip"
    kubectl apply -f "$endpoints_file"
  fi

  kubectl apply -f "$ingress_file"
  log "  Backstage Service, Endpoints, and nginx Ingress applied."
}

# ── --update-backstage-ip fast path ──────────────────────────────────────────
# Run after 'docker compose up' to refresh the Backstage Endpoints IP.
if $UPDATE_BACKSTAGE_IP; then
  if [[ "$PROVIDER" == "kind" ]]; then
    kubectl config use-context "kind-${CLUSTER_NAME}" 2>/dev/null || true
  else
    kubectl config use-context rancher-desktop 2>/dev/null || true
  fi
  log "Re-applying Backstage K8s objects with updated container IP..."
  apply_backstage_k8s_objects
  log "Done. Test with: curl -sv http://backstage.idp.local"
  exit 0
fi

# ── Helper: is the AI/ML stack actually installed on the current cluster? ────
# Used to decide the Backstage AI overlay. Deliberately checks for a real
# workload rather than just the namespace: `kubectl delete namespace` can leave
# a terminating or empty kagent namespace behind, and an empty namespace must
# not count as "AI is installed". Any failure to reach the cluster answers no,
# which is the safe direction — it hides nav items rather than showing broken ones.
_ai_stack_installed() {
  kubectl get deployment -n kagent -o name 2>/dev/null | grep -q .
}

# ── --start-backstage fast path ───────────────────────────────────────────────
# Build + start Backstage, wire nginx routing, seed QA metrics, trigger catalog
# export. Run after 'bootstrap-local.sh' finishes, or as a day-2 restart path.
_start_backstage() {
  step "Starting Backstage..."
  if [[ "$PROVIDER" == "kind" ]]; then
    kubectl config use-context "kind-${CLUSTER_NAME}" 2>/dev/null || true
    # Docker Desktop resets inotify limits on every VM restart (i.e. after every
    # machine reboot). Re-apply them here so the kubelet on the control-plane node
    # can watch files again — without this, the ingress-nginx pod stays Pending
    # and Backstage is unreachable via its hostname.
    _raise_kind_inotify_limits
  else
    kubectl config use-context rancher-desktop 2>/dev/null || true
  fi

  # The Backstage Dockerfile is multi-stage — it runs `yarn install` and
  # `yarn build:backend` inside the builder stage, so no host-side bundle
  # build is needed. Steady-state rebuilds reuse BuildKit cache mounts.
  # The compose file bind-mounts app-config.ai.yaml unconditionally, so it has
  # to exist before `up` or Docker silently creates a directory in its place and
  # Backstage dies parsing it.
  #
  # Decide on/off from the CLUSTER, not from whether the file happens to exist.
  # This used to be `if [[ ! -f ... ]]; then write_backstage_ai_overlay false; fi`
  # — seed only when absent — so that restarting Backstage on an AI-enabled
  # cluster would not switch the AI layer back off. The intent was right but the
  # test was wrong: the overlay is gitignored and lives on disk, so it OUTLIVES
  # the cluster. After `--destroy` (or a bare `kind delete cluster`) followed by a
  # fresh bootstrap, a months-old overlay still saying `aiStack.enabled: true`
  # was left untouched, and Backstage rendered AI Assistant, AI Search,
  # Approvals, KAgent, MLflow and Langfuse in the sidebar on a cluster with no
  # AI stack at all — every one of them pointing at a service that did not exist.
  # Observed 2026-08-18 on a cluster rebuilt from scratch, with an overlay dated
  # eight days earlier.
  #
  # Reading the cluster instead makes this self-healing: it corrects a stale
  # overlay no matter how the AI stack went away, and still leaves an
  # AI-enabled cluster alone because the check then passes. bootstrap-ai.sh
  # remains the thing that writes `true`.
  if _ai_stack_installed; then
    [[ -f "${ROOT_DIR}/local/backstage/app-config.ai.yaml" ]] || \
      write_backstage_ai_overlay true "$(langfuse_installed && echo true || echo false)"
  else
    write_backstage_ai_overlay false
  fi

  log "Building and starting Backstage Docker Compose..."
  ${COMPOSE_CMD} build backstage
  ${COMPOSE_CMD} up -d
  # The app-config layers are bind-mounted, so flipping app-config.ai.yaml
  # changes no compose definition and — when the image build is a cache hit and
  # the image ID is unchanged — `up -d` leaves the running container alone.
  # Backstage reads config only at startup, so without this an AI-layer toggle
  # silently does not apply and the operator sees stale nav items.
  ${COMPOSE_CMD} restart backstage
  log "Backstage starting at http://localhost:3000 (allow ~30s)"

  if [[ "$PROVIDER" == "kind" ]]; then
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
  else
    log "Waiting for Backstage container to start (rancher-desktop)..."
    for _i in {1..12}; do
      if docker inspect backstage-backstage-1 &>/dev/null; then
        log "  Container is up."
        break
      fi
      log "  Container not ready yet (${_i}/12) — retrying in 5s..."
      sleep 5
    done
  fi

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
  echo "  Backstage:      http://backstage.idp.local   (or http://localhost:3000)"
  echo "  hello-service:  http://hello-service.idp.local"
  echo "  ArgoCD:         http://argocd.idp.local"
  echo "  Grafana:        http://grafana.idp.local      (admin / admin)"
  echo "  Prometheus:     http://prometheus.idp.local"
  echo "  AlertManager:   http://alertmanager.idp.local"
  echo "  Pushgateway:    http://pushgateway.idp.local"
  echo "  OpenCost:       http://opencost.idp.local"
  echo "  Local registry: localhost:5003"
  if kubectl get ns kagent &>/dev/null 2>&1; then
  echo "  KAgent UI:      http://kagent.idp.local"
  echo "  AI Assistant:   http://backstage.idp.local/ai-assistant"
  echo "  MLflow:         http://mlflow.idp.local"
  fi
  echo ""
  echo -e "${BOLD}Day-2 tools:${RESET}"
  echo "  Scaffold a service:   ./bin/idp scaffold service --name my-svc --type nodejs"
  echo "  Register a CI runner: ./scripts/setup-runner.sh --repo <repo-name>"
  echo "  Seed QA demo metrics: ./scripts/seed-qa-metrics.sh"
  if ! kubectl get ns kagent &>/dev/null 2>&1; then
  echo "  Install AI/ML stack:  ./scripts/bootstrap-ai.sh"
  fi
  echo "  Restart Backstage:    ./scripts/bootstrap-local.sh --start-backstage"
  echo "  Teardown cluster:     ./scripts/bootstrap-local.sh --destroy"
  echo ""
  echo "  Commit your personalised repo:"
  echo "    git add . && git commit -m 'chore: initialise from backstage-platform-template'"
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
# setup.sh exports IDP_PERSONALIZATION_DONE=1 after its own initial pass so we
# don't repeat the ~700-file scan on first install. Day-2 standalone runs do
# the pass to catch any placeholders that crept back in (e.g. after git pull).
if [[ "${IDP_PERSONALIZATION_DONE:-0}" == "1" ]]; then
  log "Personalisation: skipped (already applied by setup.sh)."
else
  _apply_personalization
fi

log "Starting local IDP MVP bootstrap (cluster=$CLUSTER_NAME)"

# ── Step 0: /etc/hosts ───────────────────────────────────────────────────────
# Deliberately first. This is the only step that needs `sudo`, and it used to
# run dead last — so a 35-minute install ended by silently blocking on a
# password prompt long after the user had walked away (observed: 18 minutes of
# a 36-minute run were spent waiting here, not working). The entries are static
# 127.0.0.1 mappings that don't depend on anything the cluster does, so doing
# them up front costs nothing and gets the prompt in front of you immediately.
# Already-correct /etc/hosts needs no sudo at all and stays silent.
timer_start "0. /etc/hosts"
log "Step 0: Checking /etc/hosts entries (may prompt for your password)..."
append_hosts_file "${ROOT_DIR}/local/hosts-append.txt"
timer_end "0. /etc/hosts"

# ── Step 1: Local container registry ─────────────────────────────────────────
timer_start "1. Local registry"
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

timer_end "1. Local registry"

# ── Step 6 (runs in the background, joined before Step 13) ──────────────────
# Building and pushing images needs the local registry from Step 1 and nothing
# else — not the cluster, not ingress, not observability. It used to run
# sequentially between Step 5 and Step 8, with everything else waiting on it.
# Now it overlaps Steps 2-12; Step 13 (the ApplicationSet sync that actually
# deploys these images) joins it first.
_build_local_images() {
  # Previously this step also `helm upgrade --install`-ed hello-service into the
  # 'services' namespace just to have Step 13 uninstall it again so ArgoCD could
  # manage it in 'services-dev'. The throwaway install added ~30-60s and an
  # extra failure surface (helm --wait timeouts on first-boot image pulls) for
  # no real benefit — Step 13's ApplicationSet sync is the canonical deploy.
  log "Step 6: Building and pushing hello-service image..."
  IMAGE="localhost:${REGISTRY_PORT}/hello-service:local"
  _HELLO_VERSION="local-$(git rev-parse --short HEAD 2>/dev/null || echo 'dev')"

  # This used to rebuild and re-push on every single run regardless of whether
  # anything changed. Fingerprint covers the service source *and* the VERSION
  # build-arg (it's baked into the image, so a new commit must invalidate it),
  # and image_unchanged also confirms the tag is still in the registry — a wiped
  # registry after --destroy always forces a real build.
  _hello_fp_file="${ROOT_DIR}/.idp-cache/image-hello-service.fingerprint"
  _hello_fp="$(dir_content_hash "${ROOT_DIR}/services/hello-service"):${_HELLO_VERSION}"
  if [[ "${IDP_FORCE:-0}" != "1" ]] && image_unchanged "$_hello_fp_file" "$_hello_fp" \
       "curl -sf http://localhost:${REGISTRY_PORT}/v2/hello-service/tags/list | grep -q '\"local\"'"; then
    log "  hello-service unchanged and image present in registry — skipping build."
  else
    docker build \
      --build-arg VERSION="${_HELLO_VERSION}" \
      -t "$IMAGE" \
      "${ROOT_DIR}/services/hello-service"

    docker push "$IMAGE"
    helm_record_fingerprint "$_hello_fp_file" "$_hello_fp"
  fi

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
  # helm-values-local.yaml. hello-service is handled above.
  #
  # idp-mcp-server and qa-mcp-server used to be skipped here on the grounds that
  # bootstrap-ai.sh deploys them. That stopped being safe once the ten AI/MCP
  # services were taken off their Helm-only path and put into the ArgoCD
  # ApplicationSet: ArgoCD now creates an Application for every services/*
  # directory on a plain core bootstrap, so skipping the build left it pulling
  # localhost:5003 images that were never pushed — ImagePullBackOff on every
  # fresh local install, before bootstrap-ai.sh is ever run.
  #
  # On AWS the equivalent images live in ECR and survive between clusters, so
  # only the local path had this gap. Building them here costs one extra image
  # per bootstrap and makes local behave like AWS.
  for svc_dir in "${ROOT_DIR}/services"/*/; do
    svc=$(basename "$svc_dir")
    [[ "$svc" == "hello-service" ]] && continue
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

}

# Kick off image builds now; joined before Step 13.
_IMAGES_PID=""
_IMAGES_LOG=""
if [[ "${IDP_SKIP_IMAGE_BUILDS:-0}" != "1" ]]; then
  _IMAGES_LOG=$(mktemp)
  _build_local_images >"$_IMAGES_LOG" 2>&1 &
  _IMAGES_PID=$!
  log "Step 6: building images in the background (joined before Step 13)."
fi

# Don't orphan the background build if the run dies before Step 13 joins it.
# Supersedes the EXIT trap from timer_enable_summary, so it re-invokes
# timer_summary itself.
_kill_image_builds() {
  [[ -n "${_IMAGES_PID:-}" ]] || return 0
  pkill -P "$_IMAGES_PID" 2>/dev/null || true
  kill "$_IMAGES_PID" 2>/dev/null || true
  rm -f "${_IMAGES_LOG:-}" 2>/dev/null || true
}
trap '_kill_image_builds; timer_summary' EXIT


# ── Step 2: Kubernetes cluster ────────────────────────────────────────────────
timer_start "2. Kind cluster"
if [[ "$PROVIDER" == "kind" ]]; then
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

  # Configure containerd on each node to mirror localhost:5003 → registry:5000.
  # This uses hosts.toml (containerd v2 compatible) instead of the deprecated
  # containerdConfigPatches registry.mirrors syntax.
  _setup_kind_registry_mirrors

  # Raise inotify limits — required for kube-proxy stability under load.
  _raise_kind_inotify_limits

  # Annotate nodes so tools like kubectl know about the local registry.
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

else
  log "Step 2: Using Rancher Desktop k3s cluster (no cluster creation needed)..."
  kubectl config use-context rancher-desktop || \
    err "Could not switch to rancher-desktop context. Is Rancher Desktop running?"
  kubectl cluster-info --context rancher-desktop || \
    err "Rancher Desktop cluster is not reachable. Start Rancher Desktop and try again."

  # Configure k3s containerd mirror so the Lima VM can pull from localhost:5003 on the host.
  # host.lima.internal resolves to the Mac host from inside the Lima VM.
  log "  Configuring k3s registry mirror for localhost:${REGISTRY_PORT}..."
  rdctl shell sudo mkdir -p /etc/rancher/k3s
  rdctl shell "sudo tee /etc/rancher/k3s/registries.yaml > /dev/null" <<EOF
mirrors:
  "localhost:${REGISTRY_PORT}":
    endpoint:
      - "http://host.lima.internal:${REGISTRY_PORT}"
EOF
  log "  Restarting k3s to apply registry mirror..."
  rdctl shell sudo systemctl restart k3s
  wait_kubectl_ready 90
fi

timer_end "2. Kind cluster"

# ── Step 3: Namespaces ────────────────────────────────────────────────────────
timer_start "3. Namespaces"
log "Step 3: Creating platform namespaces..."
# A previous failed run can leave these in Terminating; wait briefly so
# kubectl apply doesn't race with finaliser cleanup.
for _ns in services services-dev monitoring argocd ingress-nginx gatekeeper-system opencost argo-workflows; do
  wait_namespace_clear "$_ns" 60
done
# Applied through _apply_or_explain so a fail-closed admission webhook produces
# an actionable message instead of a raw `failed calling webhook` dump. This is
# the first step that writes cluster resources, so it is where a wedged policy
# engine surfaces — and re-running this script is the documented way to recover a
# degraded cluster, which makes an opaque failure here especially expensive.
_apply_or_explain "$(dirname "$0")/../kubernetes/namespaces/namespaces.yaml"
_apply_or_explain "$(dirname "$0")/../kubernetes/namespaces/services-quota.yaml"
_apply_or_explain "$(dirname "$0")/../kubernetes/rbac/github-actions.yaml"
_apply_or_explain "$(dirname "$0")/../kubernetes/network-policies/default-deny.yaml"

timer_end "3. Namespaces"

# ── Step 4: nginx ingress controller ─────────────────────────────────────────
timer_start "4. Ingress + metrics-server"
log "Step 4: Installing nginx ingress controller..."
ensure_helm_repos ingress-nginx prometheus-community opencost argo grafana gatekeeper kyverno

_INGRESS_EXTRA_ARGS=()
if [[ "$PROVIDER" == "kind" ]]; then
  # Kind labels the control-plane node 'ingress-ready=true' and taints it;
  # nginx must target that node and tolerate the taint.
  _INGRESS_EXTRA_ARGS=(
    --set-string "controller.nodeSelector.ingress-ready=true"
    --set "controller.tolerations[0].key=node-role.kubernetes.io/control-plane"
    --set "controller.tolerations[0].operator=Exists"
    --set "controller.tolerations[0].effect=NoSchedule"
  )
fi

helm_upgrade_cached ingress-nginx ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx \
  --create-namespace \
  --set controller.hostPort.enabled=true \
  --set controller.service.type=NodePort \
  --set controller.resources.requests.cpu=100m \
  --set controller.resources.requests.memory=128Mi \
  --set controller.resources.limits.cpu=500m \
  --set controller.resources.limits.memory=256Mi \
  ${_INGRESS_EXTRA_ARGS[@]+"${_INGRESS_EXTRA_ARGS[@]}"} \
  --wait --timeout "${HELM_WAIT_SHORT}"

# ── Step 4c: Backstage K8s Service, Endpoints, and nginx Ingress ─────────────
# Wires the nginx controller to the Backstage Docker Compose container so that
# http://backstage.idp.local routes correctly through the Kind cluster ingress.
log "Step 4c: Applying Backstage K8s Service + Endpoints + nginx Ingress..."
apply_backstage_k8s_objects

# ── Step 4d: Backstage K8s credentials ───────────────────────────────────────
log "Step 4d: Extracting K8s credentials for Backstage plugin..."
"${ROOT_DIR}/scripts/get-k8s-credentials.sh"
log "  K8s credentials written to local/backstage/.env"

# Mirror GITHUB_ORG into local/backstage/.env so docker compose picks it up
# without needing --env-file local/.env on every restart command.
if [[ -n "${GITHUB_ORG:-}" && -f "${ROOT_DIR}/local/backstage/.env" ]]; then
  if grep -q "^GITHUB_ORG=" "${ROOT_DIR}/local/backstage/.env"; then
    sed -i.bak "s|^GITHUB_ORG=.*|GITHUB_ORG=${GITHUB_ORG}|" "${ROOT_DIR}/local/backstage/.env" && rm -f "${ROOT_DIR}/local/backstage/.env.bak"
  else
    echo "GITHUB_ORG=${GITHUB_ORG}" >> "${ROOT_DIR}/local/backstage/.env"
  fi
  log "  Mirrored GITHUB_ORG=${GITHUB_ORG} to local/backstage/.env"
fi

# ── Step 4b: metrics-server ───────────────────────────────────────────────────
log "Step 4b: Installing metrics-server (required for CPU/memory in Backstage)..."
if [[ "$PROVIDER" == "kind" ]]; then
  # Pinned to avoid pulling an untested release on first install.
  # Bump this when upgrading Kind/K8s: https://github.com/kubernetes-sigs/metrics-server/releases
  METRICS_SERVER_VERSION="v0.8.1"
  # Skip the GitHub round trip when the pinned version is already running —
  # this manifest was re-fetched over the network on every single run.
  _ms_image=$(kubectl get deployment metrics-server -n kube-system \
    -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || echo "")
  if [[ "$_ms_image" == *":${METRICS_SERVER_VERSION}" ]]; then
    log "  metrics-server ${METRICS_SERVER_VERSION} already installed — skipping."
  else
    kubectl apply -f "https://github.com/kubernetes-sigs/metrics-server/releases/download/${METRICS_SERVER_VERSION}/components.yaml"
  fi
  # Kind uses self-signed kubelet certs — patch to skip TLS verification.
  # Guarded because this is a JSON-patch *append* ("path": ".../args/-"): running
  # it unconditionally added a duplicate --kubelet-insecure-tls to the container
  # args on every bootstrap, growing the arg list without bound.
  if kubectl get deployment metrics-server -n kube-system \
       -o jsonpath='{.spec.template.spec.containers[0].args}' 2>/dev/null \
       | grep -q -- '--kubelet-insecure-tls'; then
    log "  metrics-server already patched for insecure kubelet TLS — skipping patch."
  else
    kubectl patch deployment metrics-server -n kube-system --type=json \
      -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'
  fi
else
  log "  Rancher Desktop k3s ships metrics-server pre-configured — skipping install."
fi

timer_end "4. Ingress + metrics-server"

# ── Step 5: Observability ─────────────────────────────────────────────────────
timer_start "5. Prometheus + Grafana"
if ! $SKIP_OBS; then
  log "Step 5: Installing Prometheus + Grafana (kube-prometheus-stack)..."

  # Create Grafana dashboard ConfigMaps.
  # `kubectl create ns ... | kubectl apply` would apply a *bare* Namespace and
  # strip the Pod Security labels Step 3 set from kubernetes/namespaces/namespaces.yaml
  # (apply prunes fields absent from the new last-applied-configuration).
  # Only create it when missing; Step 3 owns its labels.
  kubectl get namespace monitoring &>/dev/null || kubectl create namespace monitoring
  kubectl create configmap grafana-dashboards-idp \
    --from-file="$(dirname "$0")/../observability/grafana/dashboards/idp/" \
    -n monitoring --dry-run=client -o yaml | kubectl apply -f -
  kubectl apply -f "$(dirname "$0")/../kubernetes/monitoring/grafana-dora-dashboard-configmap.yaml"
  kubectl apply -f "$(dirname "$0")/../kubernetes/monitoring/grafana-qa-dashboard-configmap.yaml"
  kubectl apply -f "$(dirname "$0")/../kubernetes/monitoring/grafana-ai-dashboard-configmap.yaml"
  kubectl apply -f "$(dirname "$0")/../kubernetes/monitoring/grafana-finops-dashboard-configmap.yaml"
  kubectl apply -f "$(dirname "$0")/../kubernetes/monitoring/grafana-sre-dashboard-configmap.yaml"

  helm_upgrade_cached prometheus monitoring prometheus-community/kube-prometheus-stack \
    --namespace monitoring \
    --values "$(dirname "$0")/../local/observability/prometheus-stack-values.yaml" \
    --wait --timeout "${HELM_WAIT_MED}"

  kubectl apply -f "${ROOT_DIR}/observability/alertmanager/prometheus-rules.yaml"
  log "  PrometheusRules applied (SLO burn-rate, DORA anomalies, team budgets, KAgent guardrails)."

  # Sloth SLOs. The source of truth is the PrometheusServiceLevel in
  # observability/slo/, but that is a Sloth CRD with no operator installed here —
  # it has to be compiled into a PrometheusRule. Without this step the Grafana
  # SRE dashboard reports "no sloth_slo_info metrics found" on every fresh
  # cluster, which is exactly what it did before.
  #
  # Prefer regenerating when the sloth binary is present, so an edit to the
  # source takes effect without remembering to re-vendor. Otherwise apply the
  # committed output, so the bootstrap has no hard dependency on sloth.
  _slo_src="${ROOT_DIR}/observability/slo/hello-service-slos.yaml"
  _slo_gen="${ROOT_DIR}/observability/slo/generated/hello-service-slo-rules.yaml"
  if command -v sloth &>/dev/null; then
    if sloth generate -i "$_slo_src" -o /tmp/idp-slo-rules.yaml &>/dev/null; then
      kubectl apply -f /tmp/idp-slo-rules.yaml >/dev/null
      log "  Sloth SLOs applied (regenerated from ${_slo_src##*/})."
    else
      warn "  sloth generate failed — falling back to the committed rules."
      kubectl apply -f "$_slo_gen" >/dev/null
    fi
  elif [[ -f "$_slo_gen" ]]; then
    kubectl apply -f "$_slo_gen" >/dev/null
    log "  Sloth SLOs applied (committed rules; install sloth to regenerate)."
  else
    warn "  No SLO rules found — Grafana SRE dashboard will show no error budgets."
  fi

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
  # Strategy: find-or-create the 'backstage' SA, then always create a FRESH token
  # with a timestamp suffix. Stale tokens from previous runs become invalid when
  # Grafana restarts without persistence (ephemeral DB), so we always write a new one.
  GRAFANA_SA_ID=$(kubectl exec -n monitoring deploy/prometheus-grafana -c grafana -- \
    curl -sf -u admin:admin \
    "http://localhost:3000/api/serviceaccounts/search?query=backstage&perpage=1" 2>/dev/null \
    | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2 || echo "")
  if [[ -z "$GRAFANA_SA_ID" ]]; then
    GRAFANA_SA_ID=$(kubectl exec -n monitoring deploy/prometheus-grafana -c grafana -- \
      curl -sf -u admin:admin -X POST http://localhost:3000/api/serviceaccounts \
      -H 'Content-Type: application/json' \
      -d '{"name":"backstage","role":"Viewer"}' 2>/dev/null \
      | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2 || echo "")
  fi
  if [[ -n "$GRAFANA_SA_ID" ]]; then
    # Use a timestamp in the token name so re-runs never hit 409 Conflict.
    _token_name="backstage-$(date +%s)"
    GRAFANA_TOKEN=$(kubectl exec -n monitoring deploy/prometheus-grafana -c grafana -- \
      curl -sf -u admin:admin -X POST "http://localhost:3000/api/serviceaccounts/${GRAFANA_SA_ID}/tokens" \
      -H 'Content-Type: application/json' \
      -d "{\"name\":\"${_token_name}\"}" 2>/dev/null \
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

timer_end "5. Prometheus + Grafana"

# ── Steps 5b/5b-pre/5c/5d: independent Helm installs ──────────────────────────
timer_start "5b-5d. OpenCost/Rollouts/Loki/Tempo (parallel)"
# OpenCost, Argo Rollouts, Loki+Promtail, and Tempo don't depend on each other
# (different charts/namespaces/releases) — they only depend on Step 5's
# kube-prometheus-stack already being up (OpenCost queries Prometheus
# directly), which stays strictly sequential above this block. Run these four
# as background jobs instead of one after another; each keeps its own --wait,
# so this only removes the artificial serialization between them, not any
# real readiness check. None of these were wrapped in a `|| warn ... continue`
# fallback before, so a failure here still aborts the script (all four jobs
# are waited on first, then aggregated into a single err() call), matching
# the original fail-fast behavior.
if ! $SKIP_OBS; then
  log "Steps 5b/5b-pre/5c/5d: Installing OpenCost, Argo Rollouts, Loki+Promtail, Tempo in parallel..."

  _s5b_log=$(mktemp); _s5bpre_log=$(mktemp); _s5c_log=$(mktemp); _s5d_log=$(mktemp)

  (
    set -e
    kubectl apply -f "${ROOT_DIR}/kubernetes/finops/opencost.yaml"
    helm_upgrade_cached opencost opencost opencost/opencost \
      --namespace opencost \
      --set opencost.prometheus.internal.enabled=false \
      --set opencost.prometheus.external.enabled=true \
      --set "opencost.prometheus.external.url=http://prometheus-kube-prometheus-prometheus.monitoring.svc.cluster.local:9090" \
      --set opencost.exporter.defaultClusterId="${CLUSTER_NAME}" \
      --wait --timeout "${HELM_WAIT_SHORT}"
    log "  Step 5b: OpenCost installed. UI: http://opencost.idp.local"
  ) > "$_s5b_log" 2>&1 &
  _s5b_pid=$!

  (
    set -e
    # Create-if-missing rather than apply, so any labels declared elsewhere survive. See Step 5.
    kubectl get namespace argo-rollouts &>/dev/null || kubectl create namespace argo-rollouts
    helm_upgrade_cached argo-rollouts argo-rollouts argo/argo-rollouts \
      --namespace argo-rollouts \
      --values "${ROOT_DIR}/local/argocd/argo-rollouts-values.yaml" \
      --wait --timeout "${HELM_WAIT_SHORT}"
    kubectl apply -f "${ROOT_DIR}/kubernetes/argo-rollouts/analysis-template.yaml"
    log "  Step 5b-pre: Argo Rollouts installed. Dashboard: http://argo-rollouts.idp.local"
    log "  Step 5b-pre: To opt a service into canary: set rollout.enabled: true in its helm-values-local.yaml"
  ) > "$_s5bpre_log" 2>&1 &
  _s5bpre_pid=$!

  (
    set -e
    helm_upgrade_cached loki monitoring grafana/loki \
      --namespace monitoring \
      --values "${ROOT_DIR}/local/observability/loki/loki-values.yaml" \
      --wait --timeout "${HELM_WAIT_SHORT}"
    # Loki is installed but not run on this node — see the capacity note in
    # loki-values.yaml. It cannot be expressed as a value: the chart's
    # singleBinaryReplicas helper hardcodes 1 unless object storage is in use,
    # so the StatefulSet is scaled down here instead. Promtail and Tempo carry
    # the equivalent setting in their own values files.
    kubectl -n monitoring scale statefulset loki --replicas=0 2>/dev/null || true
    helm_upgrade_cached promtail monitoring grafana/promtail \
      --namespace monitoring \
      --values "${ROOT_DIR}/local/observability/loki/promtail-values.yaml" \
      --wait --timeout "${HELM_WAIT_SHORT}"
    log "  Step 5c: Loki + Promtail installed (scaled to 0 — see loki-values.yaml)."
  ) > "$_s5c_log" 2>&1 &
  _s5c_pid=$!

  (
    set -e
    helm_upgrade_cached tempo monitoring grafana/tempo \
      --namespace monitoring \
      --values "${ROOT_DIR}/local/observability/tempo/tempo-values.yaml" \
      --wait --timeout "${HELM_WAIT_SHORT}"
    kubectl apply -f "${ROOT_DIR}/local/observability/tempo/tempo-ingress.yaml"
    log "  Step 5d: Tempo installed. OTLP HTTP: http://tempo.idp.local/v1/traces | gRPC: tempo.monitoring.svc.cluster.local:4317"
    log "  Step 5d: Traces available in Grafana → Explore → Tempo datasource."
  ) > "$_s5d_log" 2>&1 &
  _s5d_pid=$!

  # Wait for all four before deciding whether to abort — matches this block's
  # original fail-fast behavior (no failure here was ever swallowed), but
  # without exiting mid-loop and leaving the other jobs running detached.
  _s5_fail=0
  _bg_join "$_s5b_pid"    "$_s5b_log"    || { warn "Step 5b (OpenCost) failed";        _s5_fail=1; }
  _bg_join "$_s5bpre_pid" "$_s5bpre_log" || { warn "Step 5b-pre (Argo Rollouts) failed"; _s5_fail=1; }
  _bg_join "$_s5c_pid"    "$_s5c_log"    || { warn "Step 5c (Loki + Promtail) failed";  _s5_fail=1; }
  _bg_join "$_s5d_pid"    "$_s5d_log"    || { warn "Step 5d (Tempo) failed";            _s5_fail=1; }
  (( _s5_fail == 0 )) || err "One or more of Steps 5b/5b-pre/5c/5d failed — see output above."
else
  log "Step 5b: Skipping OpenCost (--skip-obs)."
  log "Step 5c: Skipping Loki + Promtail (--skip-obs)."
  log "Step 5d: Skipping Tempo (--skip-obs)."
fi

# ── Step 5e: PagerDuty AlertManager secret (optional) ────────────────────────
if ! $SKIP_OBS; then
  if [[ -n "${PAGERDUTY_INTEGRATION_KEY:-}" ]]; then
    log "Step 5e: Creating PagerDuty AlertManager secret..."
    kubectl create secret generic alertmanager-pagerduty \
      --from-literal=integration-key="${PAGERDUTY_INTEGRATION_KEY}" \
      -n monitoring --dry-run=client -o yaml | kubectl apply -f -
    log "  PagerDuty secret created. Critical alerts will page on-call."
  else
    log "Step 5e: PAGERDUTY_INTEGRATION_KEY not set — skipping PagerDuty secret."
    log "  To enable: add PAGERDUTY_INTEGRATION_KEY=<key> to local/.env and re-run bootstrap."
  fi
fi

timer_end "5b-5d. OpenCost/Rollouts/Loki/Tempo (parallel)"

# ── Step 6: images ──────────────────────────────────────────────────────────
# Moved: the image build/push work now runs in the background from just after
# Step 1 (it needs only the registry, not the cluster) and is joined before
# Step 13, which is the first step that actually needs the images. See
# _build_local_images above.


# ── Step 8: ArgoCD ────────────────────────────────────────────────────────────
timer_start "8. ArgoCD"
if ! $SKIP_GITOPS; then
  log "Step 8: Installing ArgoCD..."

  _argocd_version="9.5.13"
  _argocd_values="${ROOT_DIR}/local/argocd/argocd-helm-values-local.yaml"
  _argocd_fp_file="${ROOT_DIR}/.idp-cache/argocd.fingerprint"
  _argocd_fp="${_argocd_version}:$(_sha256 "$_argocd_values")"

  # Shared post-install wiring (admin password → API token → GitHub repo
  # creds). Used both on a real install and on the skip-if-unchanged fast
  # path below, so a healthy re-run still refreshes the token/creds files
  # without paying for a full `helm upgrade --install --wait`.
  _wire_argocd_after_install() {
    ARGOCD_PASS=$(kubectl -n argocd get secret argocd-initial-admin-secret \
      -o jsonpath="{.data.password}" 2>/dev/null | base64 -d || echo "")
    log "ArgoCD ready. UI: http://argocd.idp.local  (admin / ${ARGOCD_PASS:-'not yet available'})"

    if [[ -n "$ARGOCD_PASS" ]]; then
      # The Backstage proxy sends ARGOCD_AUTH_TOKEN as a Bearer token, which
      # the ArgoCD API server only accepts as a session JWT — not the raw
      # admin password. Exchange the password for a real token via the API.
      ARGOCD_TOKEN=$(curl -s -X POST http://argocd.idp.local/api/v1/session \
        -H "Content-Type: application/json" \
        -d "{\"username\":\"admin\",\"password\":\"${ARGOCD_PASS}\"}" \
        | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
      local_env="${ROOT_DIR}/local/backstage/.env"
      if grep -q "^ARGOCD_AUTH_TOKEN=" "$local_env" 2>/dev/null; then
        sed -i.bak "s|^ARGOCD_AUTH_TOKEN=.*|ARGOCD_AUTH_TOKEN=${ARGOCD_TOKEN}|" "$local_env" && rm -f "${local_env}.bak"
      else
        echo "ARGOCD_AUTH_TOKEN=${ARGOCD_TOKEN}" >> "$local_env"
      fi
      log "  ArgoCD token written to local/backstage/.env (ARGOCD_AUTH_TOKEN)"
    fi

    local _token _org
    _token=$(grep -E '^GITHUB_TOKEN=' "${ROOT_DIR}/local/.env" | cut -d= -f2- | tr -d '"' || true)
    _org=$(grep -E '^GITHUB_ORG=' "${ROOT_DIR}/local/.env" | cut -d= -f2- | tr -d '"' || true)
    if [[ -n "$_token" && -n "$_org" && "$_org" != "YOUR_GITHUB_ORG" ]]; then
      kubectl create secret generic argocd-github-creds \
        -n argocd \
        --from-literal=type=git \
        --from-literal=url="https://github.com/${_org}" \
        --from-literal=username="${_org}" \
        --from-literal=password="${_token}" \
        --dry-run=client -o yaml \
        | kubectl label --local -f - "argocd.argoproj.io/secret-type=repo-creds" --dry-run=client -o yaml \
        | kubectl apply -f - 2>/dev/null || true
      log "  ArgoCD GitHub credentials registered for https://github.com/${_org}"
    else
      warn "  GITHUB_TOKEN or GITHUB_ORG not set in local/.env — ArgoCD will not be able to read private repos."
    fi
  }

  if helm_release_unchanged argocd argocd "$_argocd_fp_file" "$_argocd_fp"; then
    log "  ArgoCD already installed (version ${_argocd_version}, values unchanged) and Helm reports it deployed — skipping reinstall."
    log "  Run './scripts/bootstrap-local.sh --install-argocd' to force a reinstall."
    _wire_argocd_after_install
  else
    (
      set -e
      helm upgrade --install argocd argo/argo-cd \
        --namespace argocd \
        --create-namespace \
        --version "$_argocd_version" \
        --values "$_argocd_values" \
        --wait --timeout "$HELM_WAIT_MED"
    ) && { _wire_argocd_after_install; helm_record_fingerprint "$_argocd_fp_file" "$_argocd_fp"; } || {
      warn "Step 8 (ArgoCD) failed on first attempt — retrying with extended timeout..."
      wait_kubectl_ready 60
      if helm upgrade --install argocd argo/argo-cd \
        --namespace argocd \
        --create-namespace \
        --version "$_argocd_version" \
        --values "$_argocd_values" \
        --wait --timeout "$HELM_WAIT_LONG"; then
        helm_record_fingerprint "$_argocd_fp_file" "$_argocd_fp"
      else
        warn "Step 8 (ArgoCD) failed after retry — run: ./scripts/bootstrap-local.sh --install-argocd"
      fi
      # Re-wire even when the retry failed, in case an earlier partial install
      # already left ArgoCD reachable but credentials/token unwritten.
      _wire_argocd_after_install
    }
  fi
  unset -f _wire_argocd_after_install
else
  log "Step 8: Skipping ArgoCD (--skip-gitops)."
fi

# ── Step 8b: Argo Workflows (optional) ────────────────────────────────────────
if [[ "$INSTALL_ARGO_WORKFLOWS" == "true" ]]; then
  log "Step 8b: Installing Argo Workflows..."
  # Shared with bootstrap.sh and bootstrap-ai.sh — see scripts/lib.sh.
  # Non-fatal: the function warns loudly and returns non-zero on failure.
  install_argo_workflows local || true
else
  log "Step 8b: Skipping Argo Workflows (use --install-argo-workflows to enable)."
fi

timer_end "8. ArgoCD"

# ── Steps 9/9b: OPA/Gatekeeper + Kyverno ─────────────────────────────────────
timer_start "9. Gatekeeper + Kyverno (parallel)"
# Two independent policy engines (different namespaces/CRDs, neither reads a
# resource the other creates) — run them as background jobs instead of one
# after another. Both already degrade via their own `|| warn ... Continuing`,
# so this keeps that per-step behavior, just backgrounded. Critically, both
# _bg_join calls below (which block until each job finishes, including each
# one's own internal CRD/webhook-ready wait) still run before Step 10, so the
# existing invariant — Gatekeeper's and Kyverno's webhooks must be Ready
# before Steps 10–13 apply resources — is preserved exactly.
if ! $SKIP_POLICIES; then
  log "Step 9: Installing OPA/Gatekeeper..."
  _s9_log=$(mktemp)
  (
    set -e

    # Lenient probe timeouts — same rationale as local/policies/kyverno-values.yaml.
    # The chart defaults readinessTimeout/livenessTimeout to 1s, which a loaded
    # single-node Kind cluster cannot meet: the controller answers /healthz slowly
    # rather than being unhealthy, gets killed by the probe, and its
    # check-ignore-label webhook (failurePolicy=Fail) then rejects EVERY apply
    # cluster-wide with "context deadline exceeded" — including bootstrap-ai.sh's
    # own namespace/MLflow applies. The probes still catch a genuinely dead process.
    helm_upgrade_cached gatekeeper gatekeeper-system gatekeeper/gatekeeper \
      --namespace gatekeeper-system \
      --create-namespace \
      --version 3.18.2 \
      --set replicas=1 \
      --set controllerManager.readinessTimeout=15 \
      --set controllerManager.livenessTimeout=15 \
      --set audit.readinessTimeout=15 \
      --set audit.livenessTimeout=15 \
      --set controllerManager.resources.requests.cpu=100m \
      --set controllerManager.resources.requests.memory=128Mi \
      --set controllerManager.resources.limits.cpu=500m \
      --set controllerManager.resources.limits.memory=512Mi \
      --set audit.resources.requests.cpu=100m \
      --set audit.resources.requests.memory=128Mi \
      --set audit.resources.limits.cpu=500m \
      --set audit.resources.limits.memory=512Mi \
      --wait --timeout "${HELM_WAIT_MED}"

    log "Applying OPA ConstraintTemplates..."
    kubectl apply \
      -f "${ROOT_DIR}/kubernetes/policies/require-health-probes.yaml" \
      -f "${ROOT_DIR}/kubernetes/policies/require-resource-limits.yaml" \
      -f "${ROOT_DIR}/kubernetes/policies/require-labels.yaml" \
      -f "${ROOT_DIR}/kubernetes/policies/deny-latest-tag.yaml" \
      -f "${ROOT_DIR}/kubernetes/policies/require-cost-tags.yaml" 2>/dev/null || true

    log "Waiting for ConstraintTemplate CRDs to become established..."
    kubectl wait crd \
      requirehealthprobes.constraints.gatekeeper.sh \
      requireresourcelimits.constraints.gatekeeper.sh \
      requirelabels.constraints.gatekeeper.sh \
      denylatestimgtag.constraints.gatekeeper.sh \
      requirecosttags.constraints.gatekeeper.sh \
      --for=condition=Established \
      --timeout=120s

    # Wait for Gatekeeper webhook pods to be Ready before applying constraints.
    # The ValidatingWebhookConfiguration activates as soon as helm finishes; without
    # this wait, subsequent applies (Steps 10–13) can be rejected while webhook pods
    # are still starting, causing silent failures in ServiceMonitor, ApplicationSet,
    # and team namespace applies.
    log "Waiting for Gatekeeper webhook pods to be Ready..."
    kubectl wait pod \
      -n gatekeeper-system \
      -l control-plane=controller-manager \
      --for=condition=Ready \
      --timeout=120s 2>/dev/null || \
      warn "Gatekeeper webhook pods not ready after 120s — constraints may reject applies in Steps 10–13. Continuing..."

    log "Applying OPA Constraints..."
    kubectl apply \
      -f "${ROOT_DIR}/kubernetes/policies/require-health-probes.yaml" \
      -f "${ROOT_DIR}/kubernetes/policies/require-resource-limits.yaml" \
      -f "${ROOT_DIR}/kubernetes/policies/require-labels.yaml" \
      -f "${ROOT_DIR}/kubernetes/policies/deny-latest-tag.yaml" \
      -f "${ROOT_DIR}/kubernetes/policies/require-cost-tags.yaml"

    log "OPA/Gatekeeper installed."
  ) > "$_s9_log" 2>&1 &
  _s9_pid=$!
else
  log "Step 9: Skipping OPA/Gatekeeper (--skip-policies)."
  _s9_pid=""
fi

# ── Step 9b: Kyverno + team policies ─────────────────────────────────────────
# Kyverno handles admission policies that require JMESPath/CEL expressions not
# supported by Gatekeeper (e.g., extracting team name from namespace prefix).
if ! $SKIP_POLICIES; then
  _s9b_log=$(mktemp)
  (
    set -e
    log "Step 9b: Installing Kyverno..."
    helm_upgrade_cached kyverno kyverno kyverno/kyverno \
      --namespace kyverno \
      --create-namespace \
      --version 3.2.7 \
      --values "${ROOT_DIR}/local/policies/kyverno-values.yaml" \
      --set replicaCount=1 \
      --set resources.requests.cpu=100m \
      --set resources.requests.memory=256Mi \
      --set cleanupJobs.admissionReports.enabled=false \
      --set cleanupJobs.clusterAdmissionReports.enabled=false \
      --set cleanupJobs.ephemeralReports.enabled=false \
      --set cleanupJobs.clusterEphemeralReports.enabled=false \
      --set policyReportsCleanup.enabled=false \
      --set webhooksCleanup.enabled=false \
      --wait --timeout "${HELM_WAIT_SHORT}"
    # The 6 lines above disable Kyverno's optional report/webhook GC jobs rather
    # than pointing them at registry.k8s.io/kubectl (as a previous pass tried):
    # that image has no shell at all (`/bin/sh`, `/bin/bash` both missing), but
    # every one of these jobs' chart-embedded command is a `/bin/bash -c "..."`
    # pipeline — so they fail outright regardless of securityContext, and the
    # policyReportsCleanup one failing as a post-upgrade hook was also breaking
    # `helm upgrade` itself. bitnami/kubectl (the chart default, which has bash)
    # is no longer pullable at pinned tags on Docker Hub's free tier. These are
    # non-essential GC for report CRDs/stale webhooks (the chart still cleans
    # up if you `helm uninstall`); disabling them is harmless for local dev —
    # the worst case is AdmissionReport/EphemeralReport CRs accumulating, which
    # doesn't affect cluster health below the 10k-row threshold these jobs use.

    log "  Waiting for Kyverno webhook to be ready..."
    kubectl wait deployment kyverno-admission-controller \
      -n kyverno --for=condition=Available --timeout=120s
    wait_kyverno_webhook_ready

    log "  Applying Kyverno team policies..."
    kubectl apply -f "${ROOT_DIR}/kubernetes/policies/kyverno/team-quota-policy.yaml"
    # crossplane-team-label-policy.yaml's rules match on Crossplane claim kinds
    # (S3Bucket, RDSInstance, DynamoTable, SQSQueue, KafkaTopic). Local bootstrap
    # never installs Crossplane, so those CRDs never exist here — applying this
    # policy makes kyverno-admission-controller's policycache warm-up fail to
    # resolve them at startup, which is fatal and crashloops the pod forever.
    # AWS (bootstrap.sh) applies this after Crossplane CRDs are registered; local
    # has no equivalent phase because it has nothing for the policy to act on.
    log "  Skipping crossplane-team-label-policy.yaml (no Crossplane CRDs in local clusters)."
  ) > "$_s9b_log" 2>&1 &
  _s9b_pid=$!
else
  log "Step 9b: Skipping Kyverno (--skip-policies)."
  _s9b_pid=""
fi

_bg_join "$_s9_pid"  "$_s9_log"  || warn "Step 9 (OPA/Gatekeeper) failed — re-run ./scripts/bootstrap-local.sh to retry. Continuing..."
_bg_join "$_s9b_pid" "$_s9b_log" || warn "Step 9b (Kyverno) failed — Crossplane team tags and namespace quotas will not be auto-injected. Continuing..."

timer_end "9. Gatekeeper + Kyverno (parallel)"

# ── Step 10: DORA Exporter (Pushgateway) ─────────────────────────────────────
# Step 10 has no dependency on Steps 11/11a/11b/11c (different ConfigMaps,
# CronJobs and namespaces), but used to run to completion before them anyway —
# including a 5m helm --wait, two 60s rollout waits and a 30s ingress poll.
# It now runs as one more background job in the same group, joined below.
timer_start "10-11. Pushgateway/DORA + exporters (parallel)"
_step10_pid=""; _step10_log=$(mktemp)
if ! $SKIP_DORA; then
  (
    set -e
    if ! $SKIP_OBS; then
      log "Step 10: Installing Prometheus Pushgateway (separate release)..."
      helm_upgrade_cached prometheus-pushgateway monitoring prometheus-community/prometheus-pushgateway \
        --namespace monitoring \
        --set resources.requests.cpu=10m \
        --set resources.requests.memory=32Mi \
        --set resources.limits.cpu=100m \
        --set resources.limits.memory=64Mi \
        --set serviceMonitor.enabled=true \
        --set serviceMonitor.additionalLabels.release=prometheus \
        --set "extraArgs[0]=--web.enable-admin-api" \
        --wait --timeout "${HELM_WAIT_SHORT}"

      kubectl apply -f "${ROOT_DIR}/local/observability/pushgateway-ingress.yaml"
      log "Pushgateway ingress: http://pushgateway.idp.local"

      kubectl rollout status deployment/prometheus-pushgateway -n monitoring --timeout=60s
      # Admin wipe uses PUT (not DELETE) per Pushgateway API spec
      if ! kubectl exec -n monitoring deploy/prometheus-pushgateway -- \
          wget -q -O- --method=PUT http://localhost:9091/api/v1/admin/wipe 2>/dev/null; then
        warn "  Pushgateway admin wipe failed — restarting pod."
        kubectl rollout restart deployment/prometheus-pushgateway -n monitoring
        kubectl rollout status deployment/prometheus-pushgateway -n monitoring --timeout=60s
      fi
      log "Seeding QA metrics..."
      # Wait for Pushgateway to be reachable via ingress before seeding
      for _i in {1..15}; do
        if curl -sf http://pushgateway.idp.local/-/healthy &>/dev/null; then break; fi
        sleep 2
      done
      "${ROOT_DIR}/scripts/seed-qa-metrics.sh" || warn "QA metrics seed failed — run ./scripts/seed-qa-metrics.sh manually."
    fi

    log "Step 10b: Applying DORA exporter..."
    _dora_token="${GITHUB_TOKEN:-}"
    if [[ -z "$_dora_token" ]]; then
      _dora_token=$(grep -E '^GITHUB_TOKEN=' "${ROOT_DIR}/local/.env" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
    fi
    if [[ -n "$_dora_token" ]]; then
      kubectl create secret generic dora-exporter-secret \
        --from-literal=GITHUB_TOKEN="${_dora_token}" \
        -n monitoring --dry-run=client -o yaml | kubectl apply -f -
      log "  dora-exporter-secret populated."
    else
      warn "GITHUB_TOKEN not set — DORA exporter will not push metrics. Add it to local/.env and re-run."
    fi

    kubectl apply -f "${ROOT_DIR}/local/observability/dora/dora-cronjob.yaml"
    kubectl create configmap dora-exporter-script \
      --from-file=dora-exporter.py="${ROOT_DIR}/local/observability/dora/dora-exporter.py" \
      -n monitoring --dry-run=client -o yaml | kubectl apply -f -
    log "DORA exporter deployed."

    kubectl create job "dora-exporter-init-$(date +%s)" \
      --from=cronjob/dora-exporter -n monitoring \
      --dry-run=client -o yaml | kubectl apply -f - || \
      warn "  Could not trigger immediate DORA job — will run on schedule."

    if ! $SKIP_OBS; then
      log "Step 10c: Deploying catalog exporter CronJob..."
      "${ROOT_DIR}/scripts/apply-catalog-exporter.sh"
      CATALOG_CRONJOB=$(kubectl get cronjobs -n monitoring \
        -o jsonpath='{.items[?(@.metadata.name!="dora-exporter")].metadata.name}' \
        2>/dev/null | tr ' ' '\n' | head -1)
      if [[ -n "$CATALOG_CRONJOB" ]]; then
        kubectl create job "catalog-exporter-init-$(date +%s)" \
          --from="cronjob/${CATALOG_CRONJOB}" -n monitoring \
          --dry-run=client -o yaml | kubectl apply -f - || \
          warn "  Could not trigger immediate catalog job — will run on schedule."
      fi
    fi
  ) > "$_step10_log" 2>&1 &
  _step10_pid=$!
else
  log "Step 10: Skipping DORA exporter (--skip-dora)."
fi

# ── Backstage catalog API token for the exporter CronJobs ────────────────────
# app-config.local.yaml registers a static externalAccess token so in-cluster
# jobs can read the catalog without a user session, and three CronJobs
# (tech-insights-exporter, flaky-test-exporter and its quarantine job) read the
# same value from this Secret. Nothing ever created it: their secretKeyRef is
# `optional: true`, so the pods started with BACKSTAGE_TOKEN empty, sent no
# Authorization header, and every run died on
#   401 Client Error: Unauthorized for url: .../api/catalog/entities
# Parse the token out of the config rather than hardcoding it, so the two
# cannot drift; fall back to the shipped default if the parse ever fails.
if ! $SKIP_OBS; then
  _bs_catalog_token=$(awk '/externalAccess:/{f=1} f && /token:/{sub(/.*token:[[:space:]]*/,""); gsub(/"/,""); print; exit}' \
    "${ROOT_DIR}/backstage/app-config.local.yaml" 2>/dev/null || true)
  [[ -n "${_bs_catalog_token:-}" ]] || _bs_catalog_token="local-catalog-exporter-token"
  kubectl create secret generic backstage-catalog-exporter-token \
    --from-literal=token="${_bs_catalog_token}" \
    -n monitoring --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  log "  backstage-catalog-exporter-token secret ready (exporters can read the catalog API)."
fi

# ── Steps 11/11a/11b/11c: independent CronJob/manifest applies ───────────────
# None of these read state written by another (different ConfigMaps/CronJobs/
# namespaces), so they run as background jobs and are joined below instead of
# one after another. Progress output is captured per-job and printed once each
# job finishes — see _bg_join in lib.sh.
_step11_pid=""; _step11a_pid=""; _step11b_pid=""
_step11_log=$(mktemp); _step11a_log=$(mktemp); _step11b_log=$(mktemp); _step11c_log=$(mktemp)

if ! $SKIP_OBS; then
  (
    set -e
    log "Step 11: Deploying Tech Insights Exporter CronJob..."
    kubectl create configmap tech-insights-exporter-script \
      --from-file=exporter.py="${ROOT_DIR}/observability/tech-insights-exporter/exporter.py" \
      -n monitoring --dry-run=client -o yaml | kubectl apply -f -
    sed "s|BACKSTAGE_URL_PLACEHOLDER|http://backstage.default.svc.cluster.local:3000|g" \
      "${ROOT_DIR}/observability/tech-insights-exporter/cronjob.yaml" | kubectl apply -f -
    kubectl apply -f "${ROOT_DIR}/kubernetes/finops/team-budgets-configmap.yaml"
    log "  Tech Insights Exporter deployed + team budget ConfigMap applied."
  ) > "$_step11_log" 2>&1 &
  _step11_pid=$!
else
  log "Step 11: Skipping Tech Insights Exporter (--skip-obs)."
fi

# ── Step 11a: Flaky-Test Exporter ────────────────────────────────────────────
# Requires a GitHub token to read workflow run artifacts. Reuses GITHUB_TOKEN
# from local/.env if present; otherwise creates an empty Secret and warns.
if ! $SKIP_OBS; then
  (
    set -e
    log "Step 11a: Deploying Flaky-Test Exporter CronJob..."
    GH_TOKEN_FOR_FLAKE="${GITHUB_TOKEN:-}"
    if [[ -z "$GH_TOKEN_FOR_FLAKE" ]]; then
      # local/.env is never sourced into this shell (load_idp_config only reads
      # .idp-config.env, which has no token), so read it the same way Step 10b
      # and Step 12 do.
      GH_TOKEN_FOR_FLAKE=$(grep -E '^GITHUB_TOKEN=' "${ROOT_DIR}/local/.env" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
    fi
    if [[ -z "$GH_TOKEN_FOR_FLAKE" ]]; then
      warn "  GITHUB_TOKEN not set — Flaky-Test Exporter will deploy but skip every tick."
      warn "  Set GITHUB_TOKEN in local/.env (needs 'actions:read' on service repos) and re-apply."
      GH_TOKEN_FOR_FLAKE="placeholder-set-via-local-env"
    fi
    kubectl create secret generic flaky-test-exporter-github-token \
      --from-literal=token="$GH_TOKEN_FOR_FLAKE" \
      -n monitoring --dry-run=client -o yaml | kubectl apply -f -
    kubectl create configmap flaky-test-exporter-script \
      --from-file=exporter.py="${ROOT_DIR}/observability/flaky-test-exporter/exporter.py" \
      --from-file=quarantine.py="${ROOT_DIR}/observability/flaky-test-exporter/quarantine.py" \
      -n monitoring --dry-run=client -o yaml | kubectl apply -f -
    sed "s|BACKSTAGE_URL_PLACEHOLDER|http://backstage.default.svc.cluster.local:3000|g" \
      "${ROOT_DIR}/observability/flaky-test-exporter/cronjob.yaml" | kubectl apply -f -
    kubectl apply -f "${ROOT_DIR}/observability/flaky-test-exporter/quarantine-cronjob.yaml"
    log "  Flaky-Test Exporter + Quarantine Sync deployed."
  ) > "$_step11a_log" 2>&1 &
  _step11a_pid=$!
else
  log "Step 11a: Skipping Flaky-Test Exporter (--skip-obs)."
fi

# ── Step 11b: ServiceMonitor — Prometheus scraping for services namespaces ────
if ! $SKIP_OBS; then
  (
    set -e
    log "Step 11b: Applying ServiceMonitor for services namespaces..."
    kubectl apply -f "${ROOT_DIR}/kubernetes/monitoring/servicemonitor.yaml"
    log "  ServiceMonitor applied — Prometheus will scrape services/services-dev."
  ) > "$_step11b_log" 2>&1 &
  _step11b_pid=$!
fi

# ── Step 11c: Demo team namespace (awesome-team) ──────────────────────────────
(
  set -e
  log "Step 11c: Applying demo team namespace (awesome-team)..."
  kubectl apply -f "${ROOT_DIR}/kubernetes/teams/awesome-team/namespace.yaml"
  kubectl apply -f "${ROOT_DIR}/kubernetes/teams/awesome-team/rbac.yaml"
  kubectl apply -f "${ROOT_DIR}/kubernetes/teams/awesome-team/resource-quota.yaml"
  kubectl apply -f "${ROOT_DIR}/kubernetes/teams/awesome-team/limit-range.yaml"
  kubectl apply -f "${ROOT_DIR}/kubernetes/teams/awesome-team/network-policy.yaml"
  log "  Team namespace team-awesome-team ready (RBAC, quotas, network policies)."
) > "$_step11c_log" 2>&1 &
_step11c_pid=$!

_bg_join "$_step10_pid"  "$_step10_log"  || warn "Step 10 (Pushgateway/DORA) failed — re-run ./scripts/bootstrap-local.sh to retry. Continuing..."
_bg_join "$_step11_pid"  "$_step11_log"  || warn "Step 11 (Tech Insights) failed — re-run ./scripts/bootstrap-local.sh to retry. Continuing..."
_bg_join "$_step11a_pid" "$_step11a_log" || warn "Step 11a (Flaky-Test Exporter) failed — re-run ./scripts/bootstrap-local.sh to retry. Continuing..."
_bg_join "$_step11b_pid" "$_step11b_log" || warn "Step 11b (ServiceMonitor) failed — run: kubectl apply -f kubernetes/monitoring/servicemonitor.yaml"
_bg_join "$_step11c_pid" "$_step11c_log" || warn "Step 11c (team namespace) failed — run: kubectl apply -f kubernetes/teams/awesome-team/ Continuing..."

timer_end "10-11. Pushgateway/DORA + exporters (parallel)"

# ── Step 12: AlertManager Slack webhook ───────────────────────────────────────
timer_start "12. AlertManager"
log "Step 12: Wiring AlertManager..."
if [[ -z "${SLACK_WEBHOOK_URL:-}" ]]; then
  SLACK_WEBHOOK_URL=$(grep -E '^SLACK_WEBHOOK_URL=' "${ROOT_DIR}/local/.env" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
fi
if [[ -n "${SLACK_WEBHOOK_URL:-}" ]]; then
  # Not `( ... ) || warn`: bash ignores the subshell's `set -e` when the
  # subshell is the left side of an AND-OR list, so a failing kubectl would
  # fall through to the success log. Toggle errexit around it and test $?.
  set +e
  (
    set -e
    kubectl create secret generic alertmanager-slack-webhook \
      --from-literal=webhook-url="${SLACK_WEBHOOK_URL}" \
      -n monitoring --dry-run=client -o yaml | kubectl apply -f -
    kubectl apply -f "${ROOT_DIR}/observability/alertmanager/alertmanager-config.yaml"
    log "AlertManager Slack webhook configured."
  )
  _step12_rc=$?
  set -e
  [[ $_step12_rc -eq 0 ]] || warn "Step 12 (AlertManager) failed — skipping. Continuing..."
else
  warn "SLACK_WEBHOOK_URL not set — skipping AlertManager Slack routing."
fi

timer_end "12. AlertManager"

# ── Step 6 join: images must be in the registry before ArgoCD syncs ──────────
# Started right after Step 1; by now it has had Steps 2-12 to finish, so on a
# warm run this is instant. Joined here rather than earlier because Step 13's
# ApplicationSet sync is the first thing that actually needs the images.
timer_start "6. Images (join)"
_bg_join "$_IMAGES_PID" "$_IMAGES_LOG" || \
  warn "Step 6 (image build/push) failed — hello-service and scaffolded services may not start. See output above."
_IMAGES_PID=""
timer_end "6. Images (join)"

# ── Step 13: ArgoCD ApplicationSet ───────────────────────────────────────────
timer_start "13. ApplicationSet"
if ! $SKIP_GITOPS; then
  # See Step 12 for why this is not `( ... ) || warn`.
  set +e
  (
    set -e
    log "Step 13: Applying ArgoCD ApplicationSet (all environments)..."

    # Helm --wait only checks pod readiness, not API server availability.
    # Poll the ArgoCD API server directly before applying the ApplicationSet so
    # that the first sync is accepted immediately rather than failing with
    # "no matches for kind ApplicationSet" while the CRD webhooks warm up.
    log "  Waiting for ArgoCD API server to accept requests..."
    for _i in {1..30}; do
      if kubectl get crd applicationsets.argoproj.io &>/dev/null 2>&1; then
        if kubectl get applicationsets -n argocd &>/dev/null 2>&1; then
          break
        fi
      fi
      log "  ArgoCD API not ready yet (${_i}/30) — retrying in 5s..."
      sleep 5
    done

    kubectl apply -f "${ROOT_DIR}/local/argocd/app-of-apps-local.yaml" -n argocd
    log "ApplicationSet applied. ArgoCD will sync hello-service to local/dev/staging/prod."
  )
  _step13_rc=$?
  set -e
  [[ $_step13_rc -eq 0 ]] || warn "Step 13 (ApplicationSet) failed — ArgoCD may not be ready yet. Re-run bootstrap. Continuing..."
fi

timer_end "13. ApplicationSet"

# ── Done ──────────────────────────────────────────────────────────────────────
_print_url_banner

# ── --full: chain Backstage build + start after the main bootstrap ───────────
if $RUN_BACKSTAGE_AFTER; then
  _start_backstage
fi
