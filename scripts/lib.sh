#!/usr/bin/env bash
# lib.sh — Shared helpers for IDP bootstrap scripts.
# Source this file; do not execute it directly.
[[ -n "${_IDP_LIB_LOADED:-}" ]] && return 0
_IDP_LIB_LOADED=1

# ── Shared helm --wait timeouts ──────────────────────────────────────────────
# Use these instead of hand-rolled --timeout values so a slow Docker pull on a
# cold cluster doesn't silently trip the helm default (5m).
HELM_WAIT_SHORT="${HELM_WAIT_SHORT:-5m}"
HELM_WAIT_MED="${HELM_WAIT_MED:-10m}"
HELM_WAIT_LONG="${HELM_WAIT_LONG:-15m}"

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
RESET='\033[0m'

log()   { echo -e "[$(date +%T)] $*"; }
warn()  { echo -e "[$(date +%T)] ${YELLOW}WARN${RESET}  $*"; }
err()   { echo -e "[$(date +%T)] ${RED}ERROR${RESET} $*" >&2; exit 1; }
step()  { echo -e "\n${BOLD}▶ $*${RESET}"; }
check() { echo -e "[$(date +%T)] ${GREEN}✓${RESET} $*"; }

_sed() {
  if sed --version 2>&1 | grep -q GNU; then
    sed -i "$@"
  else
    sed -i '' "$@"
  fi
}

_upsert_env() {
  local file="$1" key="$2" val="$3"
  if grep -q "^${key}=" "$file" 2>/dev/null; then
    _sed "s|^${key}=.*|${key}=${val}|" "$file"
  else
    echo "${key}=${val}" >> "$file"
  fi
}

# Source .idp-config.env (the single-source-of-truth file written by setup.sh)
# into the current shell. Exports every assignment so child processes see them.
# No-op when the file is absent — callers can still rely on local/.env fallback.
load_idp_config() {
  local f="${ROOT_DIR:-$(pwd)}/.idp-config.env"
  if [[ -f "$f" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$f"
    set +a
  fi
}

# Parse scripts/placeholders.conf into parallel arrays:
#   MANIFEST_NAMES, MANIFEST_PLACEHOLDERS, MANIFEST_DEFAULTS,
#   MANIFEST_LITERALS, MANIFEST_PROMPTS, MANIFEST_REQUIREDS
# (Bash 3.2-compatible — macOS default. No associative arrays.)
#
# DEFAULTS = prompt default (display only)
# LITERALS = hardcoded value to also sed-replace (blank = none)
load_placeholder_manifest() {
  local manifest="${ROOT_DIR:-$(pwd)}/scripts/placeholders.conf"
  [[ -f "$manifest" ]] || err "Manifest not found: $manifest"
  MANIFEST_NAMES=(); MANIFEST_PLACEHOLDERS=(); MANIFEST_DEFAULTS=()
  MANIFEST_LITERALS=(); MANIFEST_PROMPTS=(); MANIFEST_REQUIREDS=()
  # Bash parameter expansion for whitespace trimming — avoids forking `echo | sed`
  # per field per row (48 subprocesses on macOS = ~9s; this is ~instant).
  _trim() {
    local s="$1"
    s="${s#"${s%%[![:space:]]*}"}"
    s="${s%"${s##*[![:space:]]}"}"
    printf '%s' "$s"
  }
  local name placeholder default literal prompt required
  while IFS='|' read -r name placeholder default literal prompt required; do
    name="$(_trim "$name")"
    [[ -z "$name" || "$name" =~ ^# ]] && continue
    placeholder="$(_trim "$placeholder")"
    default="$(_trim "$default")"
    literal="$(_trim "$literal")"
    prompt="$(_trim "$prompt")"
    required="$(_trim "$required")"
    MANIFEST_NAMES+=("$name")
    MANIFEST_PLACEHOLDERS+=("$placeholder")
    MANIFEST_DEFAULTS+=("$default")
    MANIFEST_LITERALS+=("$literal")
    MANIFEST_PROMPTS+=("$prompt")
    MANIFEST_REQUIREDS+=("$required")
  done < "$manifest"
  unset -f _trim
}

# Wait for a namespace to leave the Terminating phase before re-applying it.
# A previous failed run can leave namespaces stuck Terminating while finalisers
# clear; subsequent creates fail with "namespace is being terminated".
#   $1 = namespace name
#   $2 = optional max wait seconds (default 120)
wait_namespace_clear() {
  local ns="$1" max="${2:-120}" phase elapsed=0
  while (( elapsed < max )); do
    phase=$(kubectl get ns "$ns" -o jsonpath='{.status.phase}' 2>/dev/null || echo "")
    [[ "$phase" != "Terminating" ]] && return 0
    sleep 2
    elapsed=$((elapsed + 2))
  done
  warn "Namespace $ns still Terminating after ${max}s — continuing anyway."
}

# Wait for the Kubernetes API to respond. Useful right after a control-plane
# restart (e.g. k3s on Rancher Desktop) where kubectl racy-rejects requests.
#   $1 = optional max wait seconds (default 60)
wait_kubectl_ready() {
  local max="${1:-60}" elapsed=0
  while (( elapsed < max )); do
    kubectl get --raw='/readyz' >/dev/null 2>&1 && return 0
    sleep 2
    elapsed=$((elapsed + 2))
  done
  warn "kubectl API not ready after ${max}s — continuing, downstream steps may fail."
}

# Append entries from a hosts-style file to /etc/hosts.
#   $1 = path to source file (lines like "127.0.0.1 hostname.idp.local")
#   $2 = optional ERE filter — only lines matching this regex are processed
# Idempotent: skips entries already present. Flushes the macOS DNS cache when
# anything was added. Returns 0 even if no changes were made.
append_hosts_file() {
  local file="$1" filter="${2:-}"
  [[ -f "$file" ]] || { warn "append_hosts_file: $file not found"; return 0; }
  local added=false line hostname
  while IFS= read -r line; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ -n "$filter" ]] && ! echo "$line" | grep -qE "$filter" && continue
    hostname=$(awk '{print $2}' <<< "$line")
    [[ -z "$hostname" ]] && continue
    if ! grep -qF "$hostname" /etc/hosts 2>/dev/null; then
      if sudo sh -c "echo '$line' >> /etc/hosts"; then
        log "  Added to /etc/hosts: $hostname"
        added=true
      else
        warn "  Could not add '$hostname' to /etc/hosts. Add manually:"
        warn "  echo '$line' | sudo tee -a /etc/hosts"
      fi
    fi
  done < "$file"

  if $added; then
    if [[ "$(uname)" == "Darwin" ]]; then
      sudo dscacheutil -flushcache 2>/dev/null || true
      sudo killall -HUP mDNSResponder 2>/dev/null || true
      log "  macOS DNS cache flushed."
    elif command -v resolvectl &>/dev/null; then
      sudo resolvectl flush-caches 2>/dev/null || true
    fi
  else
    log "  /etc/hosts already up to date — no changes needed."
  fi
}

# Discover and remove user-scaffolded services from ArgoCD, Helm, and the git repo.
# Built-in platform services are never touched. Safe to call while the cluster is up;
# all cluster operations are best-effort (|| true) so failure never aborts a destroy.
#   $1 = env_suffix: "local" (Kind/Rancher) | "dev" (AWS)
_cleanup_scaffolded_services() {
  local env_suffix="${1:-local}"
  local PLATFORM_BUILTINS=("hello-service" "idp-mcp-server" "qa-mcp-server" "contract-mcp-server" "github-mcp-server" "argocd-mcp-server" "cost-mcp-server" "agent-event-router")
  local svc builtin skip

  local SCAFFOLDED=()
  if [[ -d "${ROOT_DIR}/services" ]]; then
    while IFS= read -r svc; do
      skip=false
      for builtin in "${PLATFORM_BUILTINS[@]}"; do
        [[ "$svc" == "$builtin" ]] && { skip=true; break; }
      done
      $skip || SCAFFOLDED+=("$svc")
    done < <(find "${ROOT_DIR}/services" -maxdepth 1 -mindepth 1 -type d -exec basename {} \;)
  fi

  if [[ ${#SCAFFOLDED[@]} -eq 0 ]]; then
    log "  No scaffolded services found — nothing to clean up."
    return 0
  fi

  log "  Found ${#SCAFFOLDED[@]} scaffolded service(s): ${SCAFFOLDED[*]}"

  # Delete ArgoCD Applications (cascade-deletes all managed K8s resources).
  for svc in "${SCAFFOLDED[@]}"; do
    local app_name="${svc}-${env_suffix}"
    log "  Deleting ArgoCD Application: ${app_name}"
    if command -v argocd &>/dev/null; then
      argocd app delete "${app_name}" --cascade --yes --grpc-web 2>/dev/null || true
    fi
    kubectl delete application "${app_name}" -n argocd --ignore-not-found 2>/dev/null || true
  done

  # Uninstall Helm releases (belt-and-suspenders for services deployed via idp:deploy-local).
  for svc in "${SCAFFOLDED[@]}"; do
    log "  Uninstalling Helm release: ${svc}"
    helm uninstall "${svc}" -n services-dev 2>/dev/null || true
    helm uninstall "${svc}" -n services    2>/dev/null || true
  done

  # Remove services/ directories and commit so new clusters don't re-discover them.
  local removed=()
  for svc in "${SCAFFOLDED[@]}"; do
    if [[ -d "${ROOT_DIR}/services/${svc}" ]]; then
      rm -rf "${ROOT_DIR}/services/${svc}"
      removed+=("$svc")
      log "  Removed: services/${svc}/"
    fi
  done

  # Remove IDP catalog GitHub topics so the org provider doesn't re-discover
  # these repos on the next fresh cluster install.
  if [[ -n "${GITHUB_TOKEN:-}" ]] && command -v gh &>/dev/null; then
    local org="${GITHUB_ORG:-moatazeldebsy}"
    for svc in "${SCAFFOLDED[@]}"; do
      gh repo edit "${org}/${svc}" \
        --remove-topic idp \
        --remove-topic idp-service \
        --remove-topic idp-module 2>/dev/null \
        || true
      log "  Removed IDP topics from GitHub repo: ${org}/${svc}"
    done
  fi

  # Clean up committed catalog entries for ML experiments and team-namespace groups
  # that are not covered by the services/ scan above.
  local catalog_changed=false

  if compgen -G "${ROOT_DIR}/backstage/catalog/ml-experiments/*/catalog-info.yaml" > /dev/null 2>&1; then
    find "${ROOT_DIR}/backstage/catalog/ml-experiments" -mindepth 1 -maxdepth 1 -type d \
      -exec rm -rf {} +
    catalog_changed=true
    log "  Removed stale ml-experiments catalog entries"
  fi

  local stale_groups
  stale_groups=$(find "${ROOT_DIR}/backstage/catalog/groups" -name "*.yaml" -not -name ".gitkeep" 2>/dev/null)
  if [[ -n "${stale_groups}" ]]; then
    find "${ROOT_DIR}/backstage/catalog/groups" -name "*.yaml" -not -name ".gitkeep" -delete
    catalog_changed=true
    log "  Removed stale group catalog entries"
  fi

  if [[ ${#removed[@]} -gt 0 ]]; then
    git -C "${ROOT_DIR}" add -A -- services/ 2>/dev/null || true
    if [[ "${catalog_changed}" == "true" ]]; then
      git -C "${ROOT_DIR}" add -A -- \
        backstage/catalog/ml-experiments/ \
        backstage/catalog/groups/ 2>/dev/null || true
    fi
    if ! git -C "${ROOT_DIR}" diff --cached --quiet 2>/dev/null; then
      git -C "${ROOT_DIR}" commit \
        -m "chore(cleanup): remove scaffolded services from platform repo [skip ci]" \
        2>/dev/null || true
      git -C "${ROOT_DIR}" push 2>/dev/null \
        || warn "  Could not push service cleanup to remote — commit the services/ deletions manually: ${removed[*]}"
    fi
  elif [[ "${catalog_changed}" == "true" ]]; then
    git -C "${ROOT_DIR}" add -A -- \
      backstage/catalog/ml-experiments/ \
      backstage/catalog/groups/ 2>/dev/null || true
    if ! git -C "${ROOT_DIR}" diff --cached --quiet 2>/dev/null; then
      git -C "${ROOT_DIR}" commit \
        -m "chore(cleanup): remove stale catalog entries [skip ci]" \
        2>/dev/null || true
      git -C "${ROOT_DIR}" push 2>/dev/null \
        || warn "  Could not push catalog cleanup to remote"
    fi
  fi

  log "  Scaffolded service cleanup complete."
}

# Shared placeholder-substitution engine, used by both setup.sh (first-time,
# interactive) and bootstrap-local.sh (day-2 standalone reruns). Previously each
# script carried its own copy of this logic with hand-maintained target-dir and
# exclusion lists that had drifted apart — a placeholder fixed in one script
# could still be missed by the other. Consolidating here keeps them identical.
#
# Reads resolved values via `${!name}` from already-exported MANIFEST_NAMES
# variables — setup.sh exports them from user prompts, bootstrap-local.sh
# exports them via load_idp_config() sourcing .idp-config.env. Requires
# load_placeholder_manifest to have been called first.
#
# On return, sets:
#   PERSONALIZATION_TARGETS — full candidate file list (newline-separated),
#                              for callers that need to run their own
#                              post-substitution checks (e.g. setup.sh's
#                              _verify_no_remaining).
run_personalization_pass() {
  # Union of every directory/file either script previously scanned.
  PERSONALIZATION_TARGETS=$(LC_ALL=C find \
    "${ROOT_DIR}/aws" \
    "${ROOT_DIR}/backstage/catalog" \
    "${ROOT_DIR}/backstage/app" \
    "${ROOT_DIR}/backstage/app-config.yaml" \
    "${ROOT_DIR}/backstage/app-config.local.yaml" \
    "${ROOT_DIR}/backstage/app-config.aws.yaml" \
    "${ROOT_DIR}/kubernetes" \
    "${ROOT_DIR}/local" \
    "${ROOT_DIR}/observability" \
    "${ROOT_DIR}/services" \
    "${ROOT_DIR}/terraform" \
    "${ROOT_DIR}/docs" \
    "${ROOT_DIR}/test-suites" \
    "${ROOT_DIR}/.github/workflows" \
    "${ROOT_DIR}/.github/CODEOWNERS" \
    "${ROOT_DIR}/.github/pull_request_template.md" \
    "${ROOT_DIR}/CONTRIBUTING.md" \
    "${ROOT_DIR}/CHANGELOG.md" \
    "${ROOT_DIR}/README.md" \
    "${ROOT_DIR}/mkdocs.yml" \
    \( -type d \( \
        -name node_modules -o \
        -name .yarn -o \
        -name dist -o \
        -name dist-types -o \
        -name .next -o \
        -name build -o \
        -name coverage -o \
        -name .terraform \
      \) -prune \) -o \
    \( -type f \
      ! -name '*.png' ! -name '*.jpg' ! -name '*.jpeg' ! -name '*.ico' \
      ! -name '*.gif' ! -name '*.svg' \
      ! -name '*.woff' ! -name '*.woff2' ! -name '*.ttf' ! -name '*.eot' \
      ! -name 'yarn.lock' ! -name 'package-lock.json' ! -name 'pnpm-lock.yaml' \
      ! -name 'go.sum' \
      ! -name '*.tsbuildinfo' ! -name '*.gz' ! -name '*.tgz' ! -name '*.zip' ! -name '*.tar' \
      -print \) \
    2>/dev/null) || true

  # Build sed -e args + grep needles from the manifest, reading resolved
  # values from already-exported shell variables named after MANIFEST_NAMES.
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

  # Legacy YOUR_ORG alias — PACTFLOW_ORG if set, else GITHUB_ORG.
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

  local grep_e_args=()
  for p in "${grep_patterns[@]}"; do
    grep_e_args+=(-e "$p")
  done

  # Pre-filter: only files containing at least one placeholder/literal token.
  local matching
  matching=$(printf '%s\n' "$PERSONALIZATION_TARGETS" \
    | grep -v '^$' \
    | tr '\n' '\0' \
    | xargs -0 grep -l -F "${grep_e_args[@]}" 2>/dev/null || true)

  if [[ -z "$matching" ]]; then
    log "Personalisation: no remaining placeholders (GITHUB_ORG=${GITHUB_ORG:-}) — skipping."
    return
  fi

  local count=0
  local scanned
  scanned=$(printf '%s\n' "$PERSONALIZATION_TARGETS" | grep -c . || true)
  log "Applying personalisation from manifest (GITHUB_ORG=${GITHUB_ORG:-})"
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    _sed "${sed_args[@]}" "$f" 2>/dev/null || true
    count=$((count + 1))
  done <<< "$matching"

  log "Substituted in ${count} of ${scanned} files (skipped $((scanned - count)) with no match)."
}

_preflight_check_local() {
  local missing=()
  local required_cmds=(kubectl helm docker)
  [[ "${KUBERNETES_PROVIDER:-kind}" == "kind" ]] && required_cmds+=(kind)
  for cmd in "${required_cmds[@]}"; do
    command -v "$cmd" &>/dev/null || missing+=("$cmd")
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    err "Missing required tools: ${missing[*]}
Install them and re-run, or run manually:
  ./scripts/bootstrap-local.sh"
  fi

  # Docker daemon must actually be running — `docker info` is the cheap check.
  if ! docker info >/dev/null 2>&1; then
    err "Docker daemon is not reachable. Start Docker Desktop / Rancher Desktop and re-run."
  fi

  # Free disk on the partition holding Docker storage — the Backstage build
  # alone needs ~5GB, and the cluster + observability stack chews through more.
  local free_gb
  if [[ "$(uname)" == "Darwin" ]]; then
    free_gb=$(df -g / 2>/dev/null | awk 'NR==2{print $4}')
  else
    free_gb=$(df -BG / 2>/dev/null | awk 'NR==2{gsub("G","",$4); print $4}')
  fi
  if [[ -n "${free_gb:-}" ]] && (( free_gb < 10 )); then
    warn "Low free disk (${free_gb}G on /). Bootstrap needs ~10G headroom; consider freeing space before proceeding."
  fi
}
