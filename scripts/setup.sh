#!/usr/bin/env bash
# scripts/setup.sh — One-time setup for backstage-idp-starter.
#
# Phases:
#   0. Personalise placeholders (GitHub org, AWS account, region, cluster name)
#   1. Ask which environment to start: local | aws | skip
#   2A. Local — pre-flight → bootstrap-local.sh (includes k8s credentials + catalog exporter) → Backstage
#   2B. AWS   — pre-flight → bootstrap.sh
#
# Individual scripts in scripts/ remain fully standalone for day-2 use.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck source=scripts/lib.sh
source "${ROOT_DIR}/scripts/lib.sh"

# ── Shared helper: print manual next-steps ───────────────────────────────────
_print_skip_summary() {
  echo ""
  echo -e "${BOLD}Next steps (manual):${RESET}"
  echo "  1. Fill in secrets in local/.env and local/backstage/.env"
  echo "  2. Local platform:"
  echo "       ./scripts/bootstrap-local.sh          # cluster + platform (includes K8s creds + catalog exporter)"
  echo "       ./scripts/bootstrap-local.sh --start-backstage   # build, start, wire Backstage"
  echo "  3. AWS platform:"
  echo "       cd terraform && cp terraform.tfvars.example terraform.tfvars"
  echo "       # edit terraform.tfvars, then:"
  echo "       ./scripts/bootstrap.sh"
  echo "  4. Commit your personalised repo:"
  echo "       git add . && git commit -m 'chore: initialise from backstage-idp-starter'"
  echo ""
  echo "Full docs: docs/  |  Day-2 tools: idp scaffold service / test-suite  |  scripts/setup-runner.sh"
  echo ""
}

# ════════════════════════════════════════════════════════════════════════════════
# PHASE 2A — Local (Kind) bootstrap
# ════════════════════════════════════════════════════════════════════════════════

_bootstrap_local() {
  step "Phase 2A — Local bootstrap"

  # ── Ensure .env files exist and prompt the user to fill them in ─────────────
  local env_shared="${ROOT_DIR}/local/.env"
  local env_backstage="${ROOT_DIR}/local/backstage/.env"

  if [[ ! -f "$env_shared" ]]; then
    cp "${ROOT_DIR}/local/.env.example" "$env_shared"
    log "Created local/.env from template."
  fi
  if [[ ! -f "$env_backstage" ]]; then
    cp "${ROOT_DIR}/local/backstage/.env.example" "$env_backstage"
    log "Created local/backstage/.env from template."
  fi

  echo ""
  echo -e "${BOLD}Before bootstrapping, you need three credentials:${RESET}"
  echo ""
  echo -e "${CYAN}1. GitHub Personal Access Token (PAT)${RESET} → set GITHUB_TOKEN in local/.env"
  echo "   Create at: https://github.com/settings/tokens"
  echo "   Token type: Classic | Required scopes: repo, read:org, workflow, delete_repo"
  echo ""
  echo -e "${CYAN}2. GitHub OAuth App Client ID & Secret${RESET} → set AUTH_GITHUB_CLIENT_ID and"
  echo "   AUTH_GITHUB_CLIENT_SECRET in local/backstage/.env"
  echo "   Create at: https://github.com/settings/developers → OAuth Apps → New OAuth App"
  echo "     Homepage URL : ${BACKSTAGE_URL:-http://localhost:3000}"
  echo "     Callback URL : ${BACKSTAGE_CALLBACK_URL:-http://localhost:3000/api/auth/github/handler/frame}"
  echo ""
  echo -e "${CYAN}   Note:${RESET} Your Backstage User entity is pre-configured as:"
  echo "     name / GitHub login : ${GITHUB_ORG}"
  echo "     displayName         : ${DISPLAY_NAME}"
  echo "   Sign in with GitHub using the '${GITHUB_ORG}' account to match this entity."
  echo ""
  echo -e "${CYAN}3. Backstage auth secret${RESET} → set BACKSTAGE_AUTH_SECRET in local/backstage/.env"
  echo "   Any string works locally; for production use: openssl rand -hex 32"
  echo "   (Leave blank to use the built-in dev default.)"
  echo ""
  echo "  Edit: local/.env  and  local/backstage/.env"
  echo ""
  read -rp "$(echo -e "${CYAN}Have you filled in the required tokens?${RESET} [Y/n] ")" TOKENS_READY
  TOKENS_READY="${TOKENS_READY:-Y}"
  if [[ ! "${TOKENS_READY}" =~ ^[Yy]$ ]]; then
    echo ""
    echo "Pausing here. Fill in your tokens, then re-run ./scripts/setup.sh or proceed directly:"
    echo "  ./scripts/bootstrap-local.sh"
    exit 0
  fi

  # ── Warn on empty GITHUB_TOKEN ──────────────────────────────────────────────
  local github_token=""
  [[ -f "$env_shared" ]] && github_token=$(grep -E '^GITHUB_TOKEN=' "$env_shared" | cut -d= -f2- | tr -d '"' || true)
  if [[ -z "$github_token" ]]; then
    warn "GITHUB_TOKEN is still empty in local/.env."
    warn "The DORA exporter and scaffolder templates require it."
    echo ""
    read -rp "$(echo -e "${CYAN}Continue without GITHUB_TOKEN?${RESET} [y/N] ")" SKIP_TOKEN
    [[ "${SKIP_TOKEN}" =~ ^[Yy]$ ]] || { echo "Aborted. Set GITHUB_TOKEN in local/.env and re-run."; exit 0; }
  fi

  # ── Step 1: Bootstrap the Kind cluster and platform ─────────────────────────
  # bootstrap-local.sh is idempotent and handles everything: cluster creation,
  # observability, ArgoCD, OPA, DORA exporter, K8s credentials, and catalog exporter.
  step "Step 1/3 — Bootstrapping Kind cluster and platform..."

  # Clean up any stale/unused Helm repos before installing charts
  log "Cleaning up unused Helm repositories..."
  "${ROOT_DIR}/scripts/cleanup-helm-repos.sh" 2>/dev/null || true

  log "Running scripts/bootstrap-local.sh (this takes several minutes)..."
  "${ROOT_DIR}/scripts/bootstrap-local.sh"

  # ── Step 2: Start Backstage ──────────────────────────────────────────────────
  step "Step 2/3 — Backstage"
  echo ""
  read -rp "$(echo -e "${CYAN}Start Backstage (Docker Compose) now?${RESET} [Y/n] ")" START_BS
  START_BS="${START_BS:-Y}"
  if [[ "${START_BS}" =~ ^[Yy]$ ]]; then
    "${ROOT_DIR}/scripts/bootstrap-local.sh" --start-backstage
  else
    log "Skipped. Start manually:"
    log "  ./scripts/bootstrap-local.sh --start-backstage"
  fi
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
  echo "  Scaffold a service:   idp scaffold service --name my-svc --type nodejs"
  echo "  Scaffold a test suite: idp scaffold test-suite --name my-e2e --type playwright --service my-svc"
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
[[ -z "${GITHUB_ORG}" ]] && { echo "GitHub org is required."; exit 1; }
GITHUB_ORG="${GITHUB_ORG}"

read -rp "$(echo -e "${CYAN}AWS Account ID${RESET} (12 digits, leave blank to skip): ")" AWS_ACCOUNT_ID
AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:-YOUR_AWS_ACCOUNT_ID}"

read -rp "$(echo -e "${CYAN}AWS Region${RESET} [us-east-1]: ")" AWS_REGION
AWS_REGION="${AWS_REGION:-us-east-1}"

read -rp "$(echo -e "${CYAN}EKS / Kind cluster name${RESET} [idp-mvp]: ")" CLUSTER_NAME
CLUSTER_NAME="${CLUSTER_NAME:-idp-mvp}"

read -rp "$(echo -e "${CYAN}Platform repo name${RESET} (the name of THIS repo) [backstage-idp-starter]: ")" PLATFORM_REPO
PLATFORM_REPO="${PLATFORM_REPO:-backstage-idp-starter}"

read -rp "$(echo -e "${CYAN}Backstage base URL${RESET} [http://localhost:3000]: ")" BACKSTAGE_URL
BACKSTAGE_URL="${BACKSTAGE_URL:-http://localhost:3000}"
BACKSTAGE_CALLBACK_URL="${BACKSTAGE_URL}/api/auth/github/handler/frame"

read -rp "$(echo -e "${CYAN}Your full display name${RESET} (shown in Backstage catalog, e.g. Jane Smith): ")" DISPLAY_NAME
DISPLAY_NAME="${DISPLAY_NAME:-YOUR_DISPLAY_NAME}"

echo ""
echo -e "${YELLOW}Will replace:${RESET}"
echo "  YOUR_GITHUB_ORG      → ${GITHUB_ORG}"
echo "  YOUR_DISPLAY_NAME    → ${DISPLAY_NAME}"
echo "  YOUR_AWS_ACCOUNT_ID  → ${AWS_ACCOUNT_ID}"
echo "  us-east-1            → ${AWS_REGION}"
echo "  idp-mvp (cluster)    → ${CLUSTER_NAME}"
echo "  YOUR_PLATFORM_REPO   → ${PLATFORM_REPO}"
echo ""
echo -e "${YELLOW}Backstage catalog User entity that will be created:${RESET}"
echo "  name              : ${GITHUB_ORG}"
echo "  github.com/login  : ${GITHUB_ORG}"
echo "  displayName       : ${DISPLAY_NAME}"
echo "  memberOf          : platform-team"
echo ""
echo -e "${YELLOW}GitHub OAuth App — register callback URL:${RESET}"
echo "  ${BACKSTAGE_CALLBACK_URL}"
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

if [[ "${DISPLAY_NAME}" != "YOUR_DISPLAY_NAME" ]]; then
  echo "$TARGETS" | xargs -I{} _sed \
    "s/YOUR_DISPLAY_NAME/${DISPLAY_NAME}/g" \
    {} 2>/dev/null || true
fi

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

if [[ "${PLATFORM_REPO}" != "backstage-idp-starter" ]]; then
  echo "$TARGETS" | xargs -I{} _sed \
    "s/backstage-idp-starter/${PLATFORM_REPO}/g" \
    {} 2>/dev/null || true
fi

# Replace YOUR_ORG / YOUR_REPO used in documentation code blocks
echo "$TARGETS" | xargs -I{} _sed \
  "s/YOUR_ORG/${GITHUB_ORG}/g" \
  {} 2>/dev/null || true
echo "$TARGETS" | xargs -I{} _sed \
  "s/YOUR_REPO/${PLATFORM_REPO}/g" \
  {} 2>/dev/null || true

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

# Persist org + repo to local/.env so the idp CLI and day-2 scripts can read them
if [[ -f local/.env ]]; then
  _upsert_env "local/.env" "GITHUB_ORG" "${GITHUB_ORG}"
  _upsert_env "local/.env" "PLATFORM_REPO" "${PLATFORM_REPO}"
  log "Wrote GITHUB_ORG and PLATFORM_REPO to local/.env"
fi

# Build the idp CLI so it is ready immediately after setup
if command -v go &>/dev/null; then
  step "Building idp CLI..."
  if (cd cli && go build -o ../bin/idp ./cmd/idp 2>/dev/null); then
    log "idp CLI built → ./bin/idp  (add $(pwd)/bin to PATH or run: make cli-install)"
  else
    warn "idp CLI build failed — run 'make cli-build' manually after fixing the error."
  fi
else
  warn "Go not found — skipping idp CLI build. Install Go then run: make cli-build"
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
