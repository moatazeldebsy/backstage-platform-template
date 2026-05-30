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

  # Build sed -e expressions and grep -F patterns from the manifest in one pass.
  # The grep pre-filter narrows ~700 candidate files down to those that actually
  # still contain a token, making day-2 reruns ~instant.
  local sed_args=() grep_patterns=()
  local i name placeholder literal value
  for i in "${!MANIFEST_NAMES[@]}"; do
    name="${MANIFEST_NAMES[$i]}"
    placeholder="${MANIFEST_PLACEHOLDERS[$i]}"
    literal="${MANIFEST_LITERALS[$i]}"
    value="${!name:-}"
    [[ -z "$value" || "$value" == "$placeholder" ]] && continue
    # Use | as sed delimiter so values containing / (e.g. DOCS_REPO_URL = https://...)
    # don't break the s/// expression.
    sed_args+=(-e "s|${placeholder}|${value}|g")
    sed_args+=(-e "s|\${{ ${placeholder} }}|${value}|g")
    grep_patterns+=("${placeholder}")
    if [[ -n "$literal" && "$value" != "$literal" ]]; then
      sed_args+=(-e "s|${literal}|${value}|g")
      grep_patterns+=("${literal}")
    fi
  done

  # Legacy YOUR_ORG alias. Skip when PACTFLOW_ORG itself is still the placeholder
  # (e.g. user opted out at setup) — otherwise we'd write the placeholder back into files.
  local legacy_org=""
  if [[ -n "${PACTFLOW_ORG:-}" && "$PACTFLOW_ORG" != "YOUR_PACTFLOW_ORG" ]]; then
    legacy_org="$PACTFLOW_ORG"
  elif [[ -n "${GITHUB_ORG:-}" && "$GITHUB_ORG" != "YOUR_GITHUB_ORG" ]]; then
    legacy_org="$GITHUB_ORG"
  fi
  if [[ -n "$legacy_org" && "$legacy_org" != "YOUR_ORG" ]]; then
    sed_args+=(-e "s|YOUR_ORG|${legacy_org}|g")
    grep_patterns+=("YOUR_ORG")
  fi

  if [[ ${#sed_args[@]} -eq 0 ]]; then
    log "Personalisation: no resolved values — nothing to apply."
    return
  fi

  # Prune large generated/vendored dirs with -prune (faster than -path filters,
  # which still descend before rejecting). Also skip lockfiles and binary blobs
  # that can't contain placeholders but are MB-sized.
  local targets
  targets=$(LC_ALL=C find \
    "${ROOT_DIR}/backstage/catalog" \
    "${ROOT_DIR}/backstage/app" \
    "${ROOT_DIR}/backstage/app-config.yaml" \
    "${ROOT_DIR}/kubernetes" \
    "${ROOT_DIR}/local/argocd" \
    "${ROOT_DIR}/observability" \
    "${ROOT_DIR}/services" \
    "${ROOT_DIR}/terraform" \
    "${ROOT_DIR}/test-suites" \
    "${ROOT_DIR}/.github/workflows" \
    "${ROOT_DIR}/.github/CODEOWNERS" \
    "${ROOT_DIR}/.github/pull_request_template.md" \
    "${ROOT_DIR}/CONTRIBUTING.md" \
    "${ROOT_DIR}/CHANGELOG.md" \
    "${ROOT_DIR}/README.md" \
    "${ROOT_DIR}/CLAUDE.md" \
    "${ROOT_DIR}/mkdocs.yml" \
    \( -type d \( \
        -name node_modules -o \
        -name .yarn -o \
        -name dist -o \
        -name dist-types -o \
        -name .next -o \
        -name build -o \
        -name coverage \
      \) -prune \) -o \
    \( -type f \
      ! -name '*.png' ! -name '*.jpg' ! -name '*.jpeg' ! -name '*.ico' \
      ! -name '*.gif' ! -name '*.svg' \
      ! -name 'yarn.lock' ! -name 'package-lock.json' ! -name 'pnpm-lock.yaml' \
      ! -name 'go.sum' \
      ! -name '*.tsbuildinfo' ! -name '*.gz' ! -name '*.tgz' \
      -print \) \
    2>/dev/null)

  # Assemble -e args for grep from grep_patterns
  local grep_e_args=()
  for p in "${grep_patterns[@]}"; do
    grep_e_args+=(-e "$p")
  done

  # Pre-filter: only files containing at least one placeholder/literal token.
  # NUL-delimit filenames so paths with spaces are handled correctly.
  local matching
  matching=$(printf '%s\n' "$targets" \
    | grep -v '^$' \
    | tr '\n' '\0' \
    | xargs -0 grep -l -F "${grep_e_args[@]}" 2>/dev/null || true)

  if [[ -z "$matching" ]]; then
    log "Personalisation: no remaining placeholders (GITHUB_ORG=${GITHUB_ORG}) — skipping."
    return
  fi

  local count=0
  log "Applying personalisation from manifest (GITHUB_ORG=${GITHUB_ORG})"
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    _sed "${sed_args[@]}" "$f" 2>/dev/null || true
    count=$((count + 1))
  done <<< "$matching"

  log "Personalisation applied to ${count} file(s)."
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

# ── URL banner helper (used by --print-urls and the final Done section) ───────
_print_url_banner() {
  local argocd_pass=""
  argocd_pass=$(kubectl -n argocd get secret argocd-initial-admin-secret \
    -o jsonpath="{.data.password}" 2>/dev/null | base64 -d || echo "")

  echo ""
  echo "╔═══════════════════════════════════════════════════════════════════════════╗"
  echo "║                    IDP Platform — Service URLs                           ║"
  echo "╠═══════════════════════════════════════════════════════════════════════════╣"
  echo "║  Core Platform                                                            ║"
  echo "║  Backstage        http://backstage.idp.local                             ║"
  echo "║  hello-service    http://hello-service.idp.local                         ║"
  if kubectl get svc argocd-server -n argocd &>/dev/null 2>&1; then
    if [[ -n "$argocd_pass" ]]; then
  echo "║  ArgoCD           http://argocd.idp.local          admin/${argocd_pass}  ║"
    else
  echo "║  ArgoCD           http://argocd.idp.local                                ║"
    fi
  fi
  echo "╠═══════════════════════════════════════════════════════════════════════════╣"
  echo "║  Observability                                                            ║"
  echo "║  Grafana          http://grafana.idp.local         admin/admin            ║"
  echo "║  Prometheus       http://prometheus.idp.local                             ║"
  echo "║  AlertManager     http://alertmanager.idp.local                           ║"
  echo "║  Pushgateway      http://pushgateway.idp.local                            ║"
  echo "║  OpenCost         http://opencost.idp.local                               ║"
  echo "╠═══════════════════════════════════════════════════════════════════════════╣"
  echo "║  AI / ML Platform  (install: ./scripts/bootstrap-ai.sh)                  ║"
  echo "║  KAgent UI           http://kagent.idp.local                            ║"
  echo "║  AI Assistant        http://backstage.idp.local/ai-assistant            ║"
  echo "║  MLflow              http://mlflow.idp.local                            ║"
  echo "║  IDP MCP Server      http://idp-mcp-server.idp.local/healthz            ║"
  echo "║  QA MCP Server       http://qa-mcp-server.idp.local/healthz             ║"
  echo "║  Contract MCP Server http://contract-mcp-server.idp.local/healthz       ║"
  echo "╠═══════════════════════════════════════════════════════════════════════════╣"
  echo "║  Local registry   localhost:5003                                          ║"
  echo "╚═══════════════════════════════════════════════════════════════════════════╝"
  echo ""
  if [[ -n "$argocd_pass" ]]; then
  echo "  ArgoCD admin password: ${argocd_pass}"
  echo "  (saved in local/backstage/.env as ARGOCD_AUTH_TOKEN)"
  echo ""
  fi
  echo "  Next steps:"
  echo "    Start Backstage:   ./scripts/bootstrap-local.sh --start-backstage"
  echo "    Install AI/ML:     ./scripts/bootstrap-ai.sh"
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
  helm repo add argo https://argoproj.github.io/argo-helm 2>/dev/null || true
  helm repo update argo
  helm upgrade --install argocd argo/argo-cd \
    --namespace argocd \
    --create-namespace \
    --version 9.5.13 \
    --values "${ROOT_DIR}/local/argocd/argocd-helm-values-local.yaml" \
    --wait --timeout 10m

  ARGOCD_PASS=$(kubectl -n argocd get secret argocd-initial-admin-secret \
    -o jsonpath="{.data.password}" 2>/dev/null | base64 -d || echo "")
  log "ArgoCD ready. UI: http://argocd.idp.local  (admin / ${ARGOCD_PASS:-'secret not yet available'})"

  if [[ -n "$ARGOCD_PASS" ]]; then
    local_env="${ROOT_DIR}/local/backstage/.env"
    if grep -q "^ARGOCD_AUTH_TOKEN=" "$local_env" 2>/dev/null; then
      sed -i.bak "s|^ARGOCD_AUTH_TOKEN=.*|ARGOCD_AUTH_TOKEN=${ARGOCD_PASS}|" "$local_env" && rm -f "${local_env}.bak"
    else
      echo "ARGOCD_AUTH_TOKEN=${ARGOCD_PASS}" >> "$local_env"
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
    --wait --timeout 5m
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
  warn "This will permanently delete the local IDP cluster, all workloads, volumes,"
  warn "the local Docker registry, and remove /etc/hosts entries."
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

  # ── Stop compose stack, registry, and reclaim all IDP-related Docker state ─
  # Reuses _clean_docker so destroy/reset/clean paths converge: removes the
  # compose stack with --rmi all, prunes all unused images (not just dangling),
  # drops anonymous volumes left by the local registry, and clears the buildx
  # cache (Backstage builds alone can leave several GB behind).
  _clean_docker

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
_raise_kind_inotify_limits() {
  for node in $(kind get nodes --name "$CLUSTER_NAME" 2>/dev/null); do
    docker exec --privileged "${node}" sysctl -w \
      fs.inotify.max_user_instances=8192 \
      fs.inotify.max_user_watches=524288 >/dev/null 2>&1 || \
      warn "  Node ${node}: failed to raise inotify limits."
  done
  log "  Inotify limits raised on Kind nodes."
}

# ── Helper: apply Backstage K8s Service, Endpoints, and nginx Ingress ────────
# Auto-detects the live container IP on the 'kind' Docker network so nginx can
# proxy to the Docker Compose Backstage container. Falls back to the hardcoded
# default (172.21.0.6) when the container is not yet running.
apply_backstage_k8s_objects() {
  local endpoints_file="${ROOT_DIR}/local/backstage/backstage-k8s-endpoints.yaml"
  local ingress_file="${ROOT_DIR}/local/backstage/backstage-ingress.yaml"

  local bs_ip
  if [[ "$PROVIDER" == "kind" ]]; then
    bs_ip=$(docker inspect backstage-backstage-1 \
      --format '{{(index .NetworkSettings.Networks "kind").IPAddress}}' 2>/dev/null || true)
  else
    # Rancher Desktop: Backstage container is on the default bridge; the k3s VM
    # reaches Docker containers via the host bridge IP (host.docker.internal).
    bs_ip=$(docker inspect backstage-backstage-1 \
      --format '{{(index .NetworkSettings.Networks "bridge").IPAddress}}' 2>/dev/null || true)
  fi

  if [[ -n "$bs_ip" && "$bs_ip" != "<no value>" ]]; then
    log "  Backstage container IP: ${bs_ip}"
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

# ── --start-backstage fast path ───────────────────────────────────────────────
# Build + start Backstage, wire nginx routing, seed QA metrics, trigger catalog
# export. Run after 'bootstrap-local.sh' finishes, or as a day-2 restart path.
_start_backstage() {
  step "Starting Backstage..."
  if [[ "$PROVIDER" == "kind" ]]; then
    kubectl config use-context "kind-${CLUSTER_NAME}" 2>/dev/null || true
  else
    kubectl config use-context rancher-desktop 2>/dev/null || true
  fi

  # The Backstage Dockerfile is multi-stage — it runs `yarn install` and
  # `yarn build:backend` inside the builder stage, so no host-side bundle
  # build is needed. Steady-state rebuilds reuse BuildKit cache mounts.
  log "Building and starting Backstage Docker Compose..."
  ${COMPOSE_CMD} build backstage
  ${COMPOSE_CMD} up -d
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
  echo "  KAgent UI:      http://kagent.idp.local"
  echo "  AI Assistant:   http://backstage.idp.local/ai-assistant"
  echo "  MLflow:         http://mlflow.idp.local"
  echo "  Local registry: localhost:5003"
  echo ""
  echo -e "${BOLD}Day-2 tools:${RESET}"
  echo "  Scaffold a service:   ./bin/idp scaffold service --name my-svc --type nodejs"
  echo "  Register a CI runner: ./scripts/setup-runner.sh --repo <repo-name>"
  echo "  Seed QA demo metrics: ./scripts/seed-qa-metrics.sh"
  echo "  Install AI/ML stack:  ./scripts/bootstrap-ai.sh"
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

# ── Step 2: Kubernetes cluster ────────────────────────────────────────────────
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

# ── Step 3: Namespaces ────────────────────────────────────────────────────────
log "Step 3: Creating platform namespaces..."
# A previous failed run can leave these in Terminating; wait briefly so
# kubectl apply doesn't race with finaliser cleanup.
for _ns in services services-dev monitoring argocd ingress-nginx gatekeeper-system opencost argo-workflows; do
  wait_namespace_clear "$_ns" 60
done
kubectl apply -f "$(dirname "$0")/../kubernetes/namespaces/namespaces.yaml"
kubectl apply -f "$(dirname "$0")/../kubernetes/rbac/github-actions.yaml"

# ── Step 4: nginx ingress controller ─────────────────────────────────────────
log "Step 4: Installing nginx ingress controller..."
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update ingress-nginx

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

helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx \
  --create-namespace \
  --set controller.hostPort.enabled=true \
  --set controller.service.type=NodePort \
  "${_INGRESS_EXTRA_ARGS[@]}" \
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
  kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
  # Kind uses self-signed kubelet certs — patch to skip TLS verification
  kubectl patch deployment metrics-server -n kube-system --type=json \
    -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'
else
  log "  Rancher Desktop k3s ships metrics-server pre-configured — skipping install."
fi

# ── Step 5: Observability ─────────────────────────────────────────────────────
if ! $SKIP_OBS; then
  log "Step 5: Installing Prometheus + Grafana (kube-prometheus-stack)..."
  helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
  helm repo update prometheus-community

  # Create Grafana dashboard ConfigMaps
  kubectl create namespace monitoring --dry-run=client -o yaml | kubectl apply -f -
  kubectl create configmap grafana-dashboards-idp \
    --from-file="$(dirname "$0")/../observability/grafana/dashboards/idp/" \
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
  helm repo update opencost

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

# ── Step 6: Build + push hello-service image (deploy is owned by ArgoCD) ─────
# Previously this step also `helm upgrade --install`-ed hello-service into the
# 'services' namespace just to have Step 13 uninstall it again so ArgoCD could
# manage it in 'services-dev'. The throwaway install added ~30-60s and an
# extra failure surface (helm --wait timeouts on first-boot image pulls) for
# no real benefit — Step 13's ApplicationSet sync is the canonical deploy.
log "Step 6: Building and pushing hello-service image..."
IMAGE="localhost:${REGISTRY_PORT}/hello-service:local"

docker build \
  --build-arg VERSION="local-$(git rev-parse --short HEAD 2>/dev/null || echo 'dev')" \
  -t "$IMAGE" \
  "${ROOT_DIR}/services/hello-service"

docker push "$IMAGE"

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
  (
    set -e
    helm repo add argo https://argoproj.github.io/argo-helm 2>/dev/null || true
    helm repo update argo

    helm upgrade --install argocd argo/argo-cd \
      --namespace argocd \
      --create-namespace \
      --version 9.5.13 \
      --values "${ROOT_DIR}/local/argocd/argocd-helm-values-local.yaml" \
      --wait --timeout "$HELM_WAIT_MED"

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
    fi
  ) || {
    warn "Step 8 (ArgoCD) failed on first attempt — retrying with extended timeout..."
    # Wait for the API to settle in case the previous failure was a control-plane
    # hiccup, then re-run with HELM_WAIT_LONG so slow first-boot image pulls don't
    # trip the helm default again.
    wait_kubectl_ready 60
    helm upgrade --install argocd argo/argo-cd \
      --namespace argocd \
      --create-namespace \
      --version 9.5.13 \
      --values "${ROOT_DIR}/local/argocd/argocd-helm-values-local.yaml" \
      --wait --timeout "$HELM_WAIT_LONG" \
      || warn "Step 8 (ArgoCD) failed after retry — run: ./scripts/bootstrap-local.sh --install-argocd"
  }
else
  log "Step 8: Skipping ArgoCD (--skip-gitops)."
fi

# ── Step 8b: Argo Workflows (optional) ────────────────────────────────────────
if [[ "$INSTALL_ARGO_WORKFLOWS" == "true" ]]; then
  log "Step 8b: Installing Argo Workflows..."
  (
    set -e
    helm repo add argo https://argoproj.github.io/argo-helm 2>/dev/null || true
    helm repo update argo

    helm upgrade --install argo-workflows argo/argo-workflows \
      --namespace argo-workflows \
      --create-namespace \
      -f "${REPO_ROOT}/local/argo-workflows/values.yaml" \
      --wait \
      --timeout 300s || die "Argo Workflows Helm install failed"

    kubectl apply -f "${REPO_ROOT}/kubernetes/argo-workflows/rbac.yaml"
    check "Argo Workflows installed — UI at http://argo-workflows.idp.local"
  )
else
  log "Step 8b: Skipping Argo Workflows (use --install-argo-workflows to enable)."
fi

# ── Step 9: OPA/Gatekeeper ───────────────────────────────────────────────────
if ! $SKIP_POLICIES; then
  log "Step 9: Installing OPA/Gatekeeper..."
  (
    set -e
    helm repo add gatekeeper https://open-policy-agent.github.io/gatekeeper/charts 2>/dev/null || true
    helm repo update gatekeeper

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

    log "Applying OPA Constraints..."
    kubectl apply \
      -f "${ROOT_DIR}/kubernetes/policies/require-health-probes.yaml" \
      -f "${ROOT_DIR}/kubernetes/policies/require-resource-limits.yaml" \
      -f "${ROOT_DIR}/kubernetes/policies/require-labels.yaml" \
      -f "${ROOT_DIR}/kubernetes/policies/deny-latest-tag.yaml" \
      -f "${ROOT_DIR}/kubernetes/policies/require-cost-tags.yaml"

    log "OPA/Gatekeeper installed."
  ) || warn "Step 9 (OPA/Gatekeeper) failed — re-run ./scripts/bootstrap-local.sh to retry. Continuing..."
else
  log "Step 9: Skipping OPA/Gatekeeper (--skip-policies)."
fi

# ── Step 10: DORA Exporter (Pushgateway) ─────────────────────────────────────
if ! $SKIP_DORA; then
  (
    set -e
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

      kubectl rollout status deployment/prometheus-pushgateway -n monitoring --timeout=60s
      if ! kubectl exec -n monitoring deploy/prometheus-pushgateway -- \
          wget -q -O- --method=DELETE http://localhost:9091/api/v1/admin/wipe 2>/dev/null; then
        warn "  Pushgateway admin wipe failed — restarting pod."
        kubectl rollout restart deployment/prometheus-pushgateway -n monitoring
        kubectl rollout status deployment/prometheus-pushgateway -n monitoring --timeout=60s
      fi
      log "Seeding QA metrics..."
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
  ) || warn "Step 10 (Pushgateway/DORA) failed — re-run ./scripts/bootstrap-local.sh to retry. Continuing..."
else
  log "Step 10: Skipping DORA exporter (--skip-dora)."
fi

# ── Step 11: Tech Insights Exporter ──────────────────────────────────────────
if ! $SKIP_OBS; then
  (
    set -e
    log "Step 11: Deploying Tech Insights Exporter CronJob..."
    kubectl create configmap tech-insights-exporter-script \
      --from-file=exporter.py="${ROOT_DIR}/observability/tech-insights-exporter/exporter.py" \
      -n monitoring --dry-run=client -o yaml | kubectl apply -f -
    kubectl apply -f "${ROOT_DIR}/observability/tech-insights-exporter/cronjob.yaml"
    log "  Tech Insights Exporter deployed."
  ) || warn "Step 11 (Tech Insights) failed — re-run ./scripts/bootstrap-local.sh to retry. Continuing..."
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
      warn "  GITHUB_TOKEN not set — Flaky-Test Exporter will deploy but skip every tick."
      warn "  Set GITHUB_TOKEN in local/.env (needs 'actions:read' on service repos) and re-apply."
      GH_TOKEN_FOR_FLAKE="placeholder-set-via-local-env"
    fi
    kubectl create secret generic flaky-test-exporter-github-token \
      --from-literal=token="$GH_TOKEN_FOR_FLAKE" \
      -n monitoring --dry-run=client -o yaml | kubectl apply -f -
    kubectl create configmap flaky-test-exporter-script \
      --from-file=exporter.py="${ROOT_DIR}/observability/flaky-test-exporter/exporter.py" \
      -n monitoring --dry-run=client -o yaml | kubectl apply -f -
    kubectl apply -f "${ROOT_DIR}/observability/flaky-test-exporter/cronjob.yaml"
    log "  Flaky-Test Exporter deployed."
  ) || warn "Step 11a (Flaky-Test Exporter) failed — re-run ./scripts/bootstrap-local.sh to retry. Continuing..."
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
  ) || warn "Step 11b (ServiceMonitor) failed — run: kubectl apply -f kubernetes/monitoring/servicemonitor.yaml"
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
) || warn "Step 11c (team namespace) failed — run: kubectl apply -f kubernetes/teams/awesome-team/ Continuing..."

# ── Step 12: AlertManager Slack webhook ───────────────────────────────────────
log "Step 12: Wiring AlertManager..."
if [[ -z "${SLACK_WEBHOOK_URL:-}" ]]; then
  SLACK_WEBHOOK_URL=$(grep -E '^SLACK_WEBHOOK_URL=' "${ROOT_DIR}/local/.env" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
fi
if [[ -n "${SLACK_WEBHOOK_URL:-}" ]]; then
  (
    set -e
    kubectl create secret generic alertmanager-slack-webhook \
      --from-literal=webhook-url="${SLACK_WEBHOOK_URL}" \
      -n monitoring --dry-run=client -o yaml | kubectl apply -f -
    kubectl apply -f "${ROOT_DIR}/observability/alertmanager/alertmanager-config.yaml"
    log "AlertManager Slack webhook configured."
  ) || warn "Step 12 (AlertManager) failed — skipping. Continuing..."
else
  warn "SLACK_WEBHOOK_URL not set — skipping AlertManager Slack routing."
fi

# ── Step 13: ArgoCD ApplicationSet ───────────────────────────────────────────
if ! $SKIP_GITOPS; then
  (
    set -e
    log "Step 13: Applying ArgoCD ApplicationSet (all environments)..."
    kubectl apply -f "${ROOT_DIR}/local/argocd/app-of-apps-local.yaml" -n argocd
    log "ApplicationSet applied. ArgoCD will sync hello-service to local/dev/staging/prod."
  ) || warn "Step 13 (ApplicationSet) failed — ArgoCD may not be ready yet. Re-run bootstrap. Continuing..."
fi

# ── Step 7: /etc/hosts ───────────────────────────────────────────────────────
log "Step 7: Checking /etc/hosts entries..."
append_hosts_file "${ROOT_DIR}/local/hosts-append.txt"

# ── Done ──────────────────────────────────────────────────────────────────────
_print_url_banner

# ── --full: chain Backstage build + start after the main bootstrap ───────────
if $RUN_BACKSTAGE_AFTER; then
  _start_backstage
fi
