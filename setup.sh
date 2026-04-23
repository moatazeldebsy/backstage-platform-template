#!/usr/bin/env bash
# setup.sh — One-time setup for backstage-idp-starter.
#
# Phases:
#   0. Personalise placeholders (GitHub org, AWS account, region, cluster name)
#   1. Ask which environment to start: local | aws | skip
#   2A. Local — pre-flight → bootstrap-local.sh → k8s credentials → catalog exporter → Backstage
#   2B. AWS   — pre-flight → bootstrap.sh
#
# Individual scripts in scripts/ remain fully standalone for day-2 use.
set -euo pipefail

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
RESET='\033[0m'

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log()  { echo -e "[$(date +%T)] $*"; }
warn() { echo -e "[$(date +%T)] ${YELLOW}WARN${RESET}  $*"; }
err()  { echo -e "[$(date +%T)] ${RED}ERROR${RESET} $*" >&2; exit 1; }
step() { echo -e "\n${BOLD}▶ $*${RESET}"; }

_sed() {
  # macOS (BSD sed) requires '' suffix with -i; GNU sed takes no suffix
  if sed --version 2>&1 | grep -q GNU; then
    sed -i "$@"
  else
    sed -i '' "$@"
  fi
}

# ── Shared helper: print manual next-steps ───────────────────────────────────
_print_skip_summary() {
  echo ""
  echo -e "${BOLD}Next steps (manual):${RESET}"
  echo "  1. Fill in secrets in local/.env and local/backstage/.env"
  echo "  2. Local platform:"
  echo "       ./scripts/bootstrap-local.sh"
  echo "       ./scripts/get-k8s-credentials.sh     # write K8s creds to local/backstage/.env"
  echo "       ./scripts/apply-catalog-exporter.sh  # deploy catalog CronJob"
  echo "       docker compose -f local/backstage/docker-compose.yml up -d"
  echo "  3. AWS platform:"
  echo "       cd terraform && cp terraform.tfvars.example terraform.tfvars"
  echo "       # edit terraform.tfvars, then:"
  echo "       ./scripts/bootstrap.sh"
  echo "  4. Commit your personalised repo:"
  echo "       git add . && git commit -m 'chore: initialise from backstage-idp-starter'"
  echo ""
  echo "Full docs: docs/  |  Day-2 tools: scripts/create-service.sh, scripts/setup-runner.sh"
  echo ""
}

# ════════════════════════════════════════════════════════════════════════════════
# PHASE 2A — Local (Kind) bootstrap
# ════════════════════════════════════════════════════════════════════════════════

_bootstrap_local() {
  step "Phase 2A — Local bootstrap"

  # ── Pre-flight ──────────────────────────────────────────────────────────────
  log "Checking required tools..."
  local missing=()
  for cmd in kind kubectl helm docker; do
    command -v "$cmd" &>/dev/null || missing+=("$cmd")
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    err "Missing required tools: ${missing[*]}
Install them and re-run this script, or run manually:
  ./scripts/bootstrap-local.sh"
  fi
  log "All required tools found."

  # ── Warn on empty GITHUB_TOKEN ──────────────────────────────────────────────
  local env_file="${ROOT_DIR}/local/.env"
  local github_token=""
  [[ -f "$env_file" ]] && github_token=$(grep -E '^GITHUB_TOKEN=' "$env_file" | cut -d= -f2- | tr -d '"' || true)
  if [[ -z "$github_token" ]]; then
    warn "GITHUB_TOKEN is not set in local/.env."
    warn "The DORA exporter and scaffolder templates require it."
    warn "You can set it now and re-run, or add it later and restart Backstage."
    echo ""
    read -rp "$(echo -e "${CYAN}Continue without GITHUB_TOKEN?${RESET} [y/N] ")" SKIP_TOKEN
    [[ "${SKIP_TOKEN}" =~ ^[Yy]$ ]] || { echo "Aborted. Set GITHUB_TOKEN in local/.env and re-run."; exit 0; }
  fi

  # ── Step 1: Bootstrap the Kind cluster and platform ─────────────────────────
  step "Step 1/5 — Bootstrapping Kind cluster and platform..."
  log "Running scripts/bootstrap-local.sh (this takes several minutes)..."
  "${ROOT_DIR}/scripts/bootstrap-local.sh"

  # ── Step 2: Write K8s credentials to local/backstage/.env ───────────────────
  step "Step 2/5 — Writing K8s credentials for Backstage..."
  if kubectl config get-contexts "kind-${CLUSTER_NAME}" &>/dev/null; then
    kubectl config use-context "kind-${CLUSTER_NAME}"
    "${ROOT_DIR}/scripts/get-k8s-credentials.sh"
    log "K8s credentials written to local/backstage/.env"
  else
    warn "kubectl context 'kind-${CLUSTER_NAME}' not found — skipping K8s credential setup."
    warn "Run manually after the cluster is ready: ./scripts/get-k8s-credentials.sh"
  fi

  # ── Step 3: Deploy catalog exporter ─────────────────────────────────────────
  step "Step 3/5 — Deploying Backstage catalog exporter..."
  if kubectl get namespace monitoring &>/dev/null; then
    "${ROOT_DIR}/scripts/apply-catalog-exporter.sh"
    log "Catalog exporter CronJob deployed."
  else
    warn "Namespace 'monitoring' not found — skipping catalog exporter."
    warn "Run manually once observability is up: ./scripts/apply-catalog-exporter.sh"
  fi

  # ── Step 4: Start Backstage ──────────────────────────────────────────────────
  step "Step 4/5 — Backstage"
  echo ""
  read -rp "$(echo -e "${CYAN}Start Backstage (Docker Compose) now?${RESET} [Y/n] ")" START_BS
  START_BS="${START_BS:-Y}"
  if [[ "${START_BS}" =~ ^[Yy]$ ]]; then
    log "Building and starting Backstage..."
    docker compose -f "${ROOT_DIR}/local/backstage/docker-compose.yml" \
      build backstage
    docker compose -f "${ROOT_DIR}/local/backstage/docker-compose.yml" \
      up -d
    log "Backstage is starting at http://localhost:3000 (allow ~30s)"
  else
    log "Skipped. Start manually:"
    log "  docker compose -f local/backstage/docker-compose.yml up -d"
  fi

  # ── Step 5: Summary ──────────────────────────────────────────────────────────
  step "Step 5/5 — Done!"
  echo ""
  echo -e "${GREEN}✓ Local IDP platform is up.${RESET}"
  echo ""
  echo -e "${BOLD}Access URLs:${RESET}"
  echo "  Backstage:      http://localhost:3000  (or http://backstage.idp.local after /etc/hosts)"
  echo "  hello-service:  http://hello-service.idp.local"
  echo "  Grafana:        http://grafana.idp.local          (admin / admin)"
  echo "  ArgoCD:         http://argocd.idp.local"
  echo "  OpenCost:       http://opencost.idp.local"
  echo "  MLflow:         http://mlflow.idp.local"
  echo "  Argo Workflows: http://argo-workflows.idp.local"
  echo ""
  echo -e "${BOLD}Day-2 tools:${RESET}"
  echo "  Scaffold a service:   ./scripts/create-service.sh --name my-svc --type nodejs"
  echo "  Register a CI runner: ./scripts/setup-runner.sh --repo <repo-name>"
  echo "  Seed QA demo metrics: ./scripts/seed-qa-metrics.sh"
  echo "  Teardown cluster:     ./scripts/bootstrap-local.sh --destroy"
  echo ""
  echo "  Commit your personalised repo:"
  echo "    git add . && git commit -m 'chore: initialise from backstage-idp-starter'"
  echo ""
}

# ════════════════════════════════════════════════════════════════════════════════
# PHASE 2B — AWS bootstrap
# ════════════════════════════════════════════════════════════════════════════════

_bootstrap_aws() {
  step "Phase 2B — AWS bootstrap"

  # ── Pre-flight ──────────────────────────────────────────────────────────────
  log "Checking required tools..."
  local missing=()
  for cmd in aws terraform kubectl helm docker; do
    command -v "$cmd" &>/dev/null || missing+=("$cmd")
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    err "Missing required tools: ${missing[*]}
Install them and re-run this script, or run manually:
  ./scripts/bootstrap.sh"
  fi

  log "Verifying AWS credentials..."
  aws sts get-caller-identity &>/dev/null \
    || err "AWS credentials not configured. Run 'aws configure' or set AWS_PROFILE and retry."

  local caller
  caller=$(aws sts get-caller-identity --query 'Arn' --output text)
  log "Authenticated as: ${caller}"

  # ── Terraform vars ──────────────────────────────────────────────────────────
  local tfvars="${ROOT_DIR}/terraform/terraform.tfvars"
  if [[ ! -f "$tfvars" ]]; then
    if [[ -f "${ROOT_DIR}/terraform/terraform.tfvars.example" ]]; then
      cp "${ROOT_DIR}/terraform/terraform.tfvars.example" "$tfvars"
      log "Created terraform/terraform.tfvars from example."
      echo ""
      warn "Review and edit terraform/terraform.tfvars before proceeding."
      warn "At minimum set: aws_region, cluster_name, github_org."
      echo ""
      read -rp "$(echo -e "${CYAN}Have you reviewed terraform.tfvars and are ready to proceed?${RESET} [y/N] ")" TF_READY
      [[ "${TF_READY}" =~ ^[Yy]$ ]] || { echo "Aborted. Edit terraform/terraform.tfvars and re-run."; exit 0; }
    else
      warn "terraform/terraform.tfvars.example not found — proceeding without it."
    fi
  else
    log "terraform/terraform.tfvars already exists — using it as-is."
  fi

  # ── Bootstrap AWS ────────────────────────────────────────────────────────────
  step "Bootstrapping AWS EKS platform..."
  log "Running scripts/bootstrap.sh (this takes 15–25 minutes)..."
  "${ROOT_DIR}/scripts/bootstrap.sh" \
    --region "${AWS_REGION}" \
    --cluster-name "${CLUSTER_NAME}"

  # ── Summary ──────────────────────────────────────────────────────────────────
  step "Done!"
  echo ""
  echo -e "${GREEN}✓ AWS IDP platform provisioned.${RESET}"
  echo ""
  echo -e "${BOLD}Next steps:${RESET}"
  echo "  1. Verify EKS cluster:  kubectl get nodes"
  echo "  2. Open Backstage:      kubectl get ingress -n backstage"
  echo "  3. Push first image:    git push origin main  (triggers GitHub Actions CI/CD)"
  echo ""
  echo -e "${BOLD}Day-2 tools:${RESET}"
  echo "  Scaffold a service:   ./scripts/create-service.sh --name my-svc --type nodejs"
  echo "  Register a CI runner: ./scripts/setup-runner.sh --repo <repo-name>"
  echo ""
  echo "  Commit your personalised repo:"
  echo "    git add . && git commit -m 'chore: initialise from backstage-idp-starter'"
  echo ""
}

# ════════════════════════════════════════════════════════════════════════════════
# MAIN
# ════════════════════════════════════════════════════════════════════════════════

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║     backstage-idp-starter  ·  Setup         ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════════════╝${RESET}"
echo ""
echo "This script personalises your copy of the template and optionally"
echo "bootstraps the full platform end-to-end."
echo ""

# ════════════════════════════════════════════════════════════════════════════════
# PHASE 0 — Personalisation
# ════════════════════════════════════════════════════════════════════════════════

step "Phase 0 — Personalisation"

# ── Gather inputs ────────────────────────────────────────────────────────────

read -rp "$(echo -e "${CYAN}GitHub org or username${RESET} (e.g. acme-corp): ")" GITHUB_ORG
GITHUB_ORG="${GITHUB_ORG:-YOUR_GITHUB_ORG}"

read -rp "$(echo -e "${CYAN}AWS Account ID${RESET} (12 digits, leave blank to skip): ")" AWS_ACCOUNT_ID
AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:-YOUR_AWS_ACCOUNT_ID}"

read -rp "$(echo -e "${CYAN}AWS Region${RESET} [us-east-1]: ")" AWS_REGION
AWS_REGION="${AWS_REGION:-us-east-1}"

read -rp "$(echo -e "${CYAN}EKS / Kind cluster name${RESET} [idp-mvp]: ")" CLUSTER_NAME
CLUSTER_NAME="${CLUSTER_NAME:-idp-mvp}"

echo ""
echo -e "${YELLOW}Will replace:${RESET}"
echo "  YOUR_GITHUB_ORG      → ${GITHUB_ORG}"
echo "  YOUR_AWS_ACCOUNT_ID  → ${AWS_ACCOUNT_ID}"
echo "  us-east-1            → ${AWS_REGION}"
echo "  idp-mvp (cluster)    → ${CLUSTER_NAME}"
echo ""
read -rp "Proceed with personalisation? [y/N] " CONFIRM
[[ "${CONFIRM}" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }

# ── Find-replace ─────────────────────────────────────────────────────────────

log "Applying substitutions..."

# Collect text files (skip binary, git internals, and this script itself)
TARGETS=$(LC_ALL=C find . -type f \
  ! -path './.git/*' \
  ! -name 'setup.sh' \
  ! -name '*.png' ! -name '*.jpg' ! -name '*.jpeg' ! -name '*.ico' \
  ! -name '*.woff' ! -name '*.woff2' ! -name '*.ttf' ! -name '*.eot' \
  ! -name '*.gz' ! -name '*.zip' ! -name '*.tar' \
  2>/dev/null)

echo "$TARGETS" | xargs -I{} _sed \
  "s/YOUR_GITHUB_ORG/${GITHUB_ORG}/g" \
  {} 2>/dev/null || true

if [[ "${AWS_ACCOUNT_ID}" != "YOUR_AWS_ACCOUNT_ID" ]]; then
  echo "$TARGETS" | xargs -I{} _sed \
    "s/YOUR_AWS_ACCOUNT_ID/${AWS_ACCOUNT_ID}/g" \
    {} 2>/dev/null || true
fi

if [[ "${AWS_REGION}" != "us-east-1" ]]; then
  echo "$TARGETS" | xargs -I{} _sed \
    "s/us-east-1/${AWS_REGION}/g" \
    {} 2>/dev/null || true
fi

if [[ "${CLUSTER_NAME}" != "idp-mvp" ]]; then
  echo "$TARGETS" | xargs -I{} _sed \
    "s/idp-mvp/${CLUSTER_NAME}/g" \
    {} 2>/dev/null || true
fi

log "Substitutions applied."

# ── Bootstrap env files ───────────────────────────────────────────────────────

if [[ -f local/.env.example && ! -f local/.env ]]; then
  cp local/.env.example local/.env
  log "Created local/.env — fill in your tokens before starting the platform."
fi

if [[ -f local/backstage/.env.example && ! -f local/backstage/.env ]]; then
  cp local/backstage/.env.example local/backstage/.env
  log "Created local/backstage/.env — fill in your tokens before starting Backstage."
fi

echo ""
echo -e "${GREEN}✓ Personalisation complete.${RESET}"

# ════════════════════════════════════════════════════════════════════════════════
# PHASE 1 — Mode selection
# ════════════════════════════════════════════════════════════════════════════════

echo ""
echo "What would you like to do next?"
echo "  local  — Bootstrap the full platform locally (Kind cluster, no AWS needed)"
echo "  aws    — Provision and bootstrap on AWS EKS (requires Terraform + AWS creds)"
echo "  skip   — Stop here; run scripts manually when ready"
echo ""
read -rp "$(echo -e "${CYAN}Environment${RESET} [local/aws/skip]: ")" SETUP_MODE
SETUP_MODE="${SETUP_MODE:-skip}"

# ════════════════════════════════════════════════════════════════════════════════
# Dispatch
# ════════════════════════════════════════════════════════════════════════════════

case "${SETUP_MODE}" in
  local) _bootstrap_local ;;
  aws)   _bootstrap_aws   ;;
  skip)
    _print_skip_summary
    exit 0
    ;;
  *)
    warn "Unrecognised option '${SETUP_MODE}' — defaulting to skip."
    _print_skip_summary
    exit 0
    ;;
esac
