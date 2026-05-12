#!/usr/bin/env bash
# cleanup-helm-repos.sh — Remove Helm chart repositories that are not used by
# any script in this project, and ensure the required repos are present.
#
# Usage:
#   ./scripts/cleanup-helm-repos.sh          # remove unused repos, verify required ones
#   ./scripts/cleanup-helm-repos.sh --dry-run # show what would be removed without acting
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck source=scripts/lib.sh
source "${ROOT_DIR}/scripts/lib.sh"

DRY_RUN=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    *) err "Unknown flag: $1" ;;
  esac
done

# ── Repos that are NOT used by any script in this project ────────────────────
# backstage        — Backstage runs via Docker Compose (local) or k8s manifests (AWS)
# chaos-mesh       — not used anywhere in the platform
# jetstack         — cert-manager is not installed
# kubecost         — replaced by OpenCost
# open-telemetry   — not installed in any bootstrap script
# crossplane-stable — not used in any bootstrap script
# nvidia           — not used
# fairwinds-stable  — not used
# community-charts — not referenced by any bootstrap-local.sh or bootstrap.sh install
UNUSED_REPOS=(
  backstage
  chaos-mesh
  jetstack
  kubecost
  open-telemetry
  crossplane-stable
  nvidia
  fairwinds-stable
  community-charts
)

# ── Repos that ARE required by bootstrap-local.sh / bootstrap.sh ─────────────
# Format: "repo-name|url"
REQUIRED_REPOS=(
  "ingress-nginx|https://kubernetes.github.io/ingress-nginx"
  "prometheus-community|https://prometheus-community.github.io/helm-charts"
  "argo|https://argoproj.github.io/argo-helm"
  "gatekeeper|https://open-policy-agent.github.io/gatekeeper/charts"
  "opencost|https://opencost.github.io/opencost-helm-chart"
  "external-secrets|https://charts.external-secrets.io"
  "grafana|https://grafana.github.io/helm-charts"
)

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║       Helm Repository Cleanup                ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════════════╝${RESET}"
echo ""
[[ "$DRY_RUN" == "true" ]] && echo -e "${YELLOW}DRY-RUN mode — no changes will be made${RESET}\n"

# ── Step 1: Remove unused repos ───────────────────────────────────────────────
log "Removing unused Helm repositories..."
REMOVED=0
for repo in "${UNUSED_REPOS[@]}"; do
  if helm repo list 2>/dev/null | awk '{print $1}' | grep -q "^${repo}$"; then
    if [[ "$DRY_RUN" == "true" ]]; then
      echo -e "  ${YELLOW}[dry-run]${RESET} Would remove: ${repo}"
    else
      helm repo remove "$repo"
      echo -e "  ${GREEN}Removed:${RESET} ${repo}"
      REMOVED=$((REMOVED + 1))
    fi
  else
    echo -e "  ${CYAN}Not present:${RESET} ${repo} (skip)"
  fi
done

if [[ "$DRY_RUN" != "true" && $REMOVED -gt 0 ]]; then
  log "Removed ${REMOVED} unused repo(s)."
elif [[ $REMOVED -eq 0 && "$DRY_RUN" != "true" ]]; then
  log "No unused repos found — nothing to remove."
fi

echo ""

# ── Step 2: Ensure required repos are present ────────────────────────────────
log "Verifying required Helm repositories..."
ADDED=0
for entry in "${REQUIRED_REPOS[@]}"; do
  repo="${entry%%|*}"
  url="${entry#*|}"
  if helm repo list 2>/dev/null | awk '{print $1}' | grep -q "^${repo}$"; then
    echo -e "  ${GREEN}Present:${RESET} ${repo}"
  else
    if [[ "$DRY_RUN" == "true" ]]; then
      echo -e "  ${YELLOW}[dry-run]${RESET} Would add: ${repo} → ${url}"
    else
      helm repo add "$repo" "$url"
      echo -e "  ${GREEN}Added:${RESET} ${repo} → ${url}"
      ADDED=$((ADDED + 1))
    fi
  fi
done

if [[ "$DRY_RUN" != "true" && $ADDED -gt 0 ]]; then
  helm repo update
  log "Updated ${ADDED} newly added repo(s)."
fi

echo ""

# ── Step 3: Show final state ──────────────────────────────────────────────────
log "Current Helm repositories:"
helm repo list 2>/dev/null || echo "  (none)"
echo ""
log "Done."
