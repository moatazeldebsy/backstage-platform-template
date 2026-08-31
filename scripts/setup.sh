#!/usr/bin/env bash
# scripts/setup.sh — One-time setup for backstage-platform-template.
#
# Phases:
#   0. Personalise placeholders (GitHub org, AWS account, region, cluster name)
#   1. Ask which environment to start: local | aws | multi | skip
#   2A. Local       — pre-flight → bootstrap-local.sh → Backstage
#   2B. AWS         — single-region EKS → bootstrap.sh
#   2C. Multi-region — active-standby EKS (eu-central-1 + us-east-1) → bootstrap-multiregion.sh
#
# Individual scripts in scripts/ remain fully standalone for day-2 use.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck source=scripts/lib.sh
source "${ROOT_DIR}/scripts/lib.sh"

# Per-step wall-clock timings, printed as a slowest-first table on exit
# (including on failure). Set IDP_TIMING=0 to silence.
timer_enable_summary

# ── Shared helper: print manual next-steps ───────────────────────────────────
_print_skip_summary() {
  echo ""
  echo -e "${BOLD}Next steps (manual):${RESET}"
  echo "  1. Fill in secrets in local/.env and local/backstage/.env"
  echo ""
  echo "  2. Local platform (Kind — no AWS required):"
  echo "       ./scripts/bootstrap-local.sh          # cluster + platform + K8s creds"
  echo "       ./scripts/bootstrap-local.sh --start-backstage   # build + start Backstage"
  echo ""
  echo "  3. AWS platform — single-region (us-east-1 or custom):"
  echo "       cd terraform && cp terraform.tfvars.example terraform.tfvars"
  echo "       # edit terraform.tfvars, then:"
  echo "       ./scripts/bootstrap.sh [--region eu-central-1] [--cluster-name idp-mvp]"
  echo ""
  echo "  4. AWS platform — multi-region active-standby (eu-central-1 primary + us-east-1 standby):"
  echo "       # review terraform/tfvars/eu-central-1.tfvars and terraform/tfvars/us-east-1.tfvars"
  echo "       # review terraform/global/terraform.tfvars.example → terraform/global/terraform.tfvars"
  echo "       ./scripts/bootstrap-multiregion.sh"
  echo "       # optional flags: --skip-global  --skip-standby  --skip-obs  --skip-ai"
  echo ""
  echo "  5. Commit your personalised repo:"
  echo "       git add . && git commit -m 'chore: initialise from backstage-platform-template'"
  echo ""
  echo "Full docs: docs/  |  Multi-region guide: docs/multi-region.md  |  Day-2: idp scaffold service"
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

  # Generate the Backstage signing key rather than asking for it. This used to be
  # a manual step whose instructions ended "leave blank to use the built-in dev
  # default" — which is precisely how a literal published in this repo ended up
  # signing tokens.
  if ! grep -qE '^BACKSTAGE_AUTH_SECRET=.+' "$env_backstage" 2>/dev/null; then
    local generated
    generated=$(openssl rand -hex 32 2>/dev/null || python3 -c 'import secrets; print(secrets.token_hex(32))')
    if grep -qE '^BACKSTAGE_AUTH_SECRET=' "$env_backstage" 2>/dev/null; then
      python3 - "$env_backstage" "$generated" <<'PYEOF'
import sys, re
path, value = sys.argv[1], sys.argv[2]
text = open(path).read()
open(path, 'w').write(re.sub(r'^BACKSTAGE_AUTH_SECRET=.*$',
                             'BACKSTAGE_AUTH_SECRET=' + value, text, flags=re.M))
PYEOF
    else
      printf '\nBACKSTAGE_AUTH_SECRET=%s\n' "$generated" >> "$env_backstage"
    fi
    log "Generated BACKSTAGE_AUTH_SECRET in local/backstage/.env."
  fi

  echo ""
  echo -e "${BOLD}Before bootstrapping, you need these credentials:${RESET}"
  echo ""
  echo -e "${CYAN}1. GitHub Personal Access Token (PAT)${RESET} → set GITHUB_TOKEN in local/.env"
  echo "   Create at: https://github.com/settings/tokens"
  echo "   Token type: Classic | Required scopes: repo, read:org, workflow, delete_repo"
  echo "   Used by: DORA exporter, scaffolder templates, catalog import (local dev)"
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
  echo -e "${CYAN}3. Backstage auth secret${RESET} → generated for you in local/backstage/.env"
  echo "   Nothing to do. There is no default: an unset value now fails startup"
  echo "   rather than silently signing tokens with a shared key."
  echo ""
  echo -e "${CYAN}4. GitHub App (production/AWS only — optional for local dev)${RESET}"
  echo "   Replaces the PAT for Backstage API calls and auto-merge CI."
  echo "   Higher rate limits, no expiry, per-repo scoping."
  echo "   Create at: github.com/settings/apps/new"
  echo "   Required permissions: Contents=Read, Pull requests=Write, Members=Read"
  echo "   After creating: add APP_ID + APP_PRIVATE_KEY as GitHub Actions repo secrets."
  echo "   For AWS/production: store the 5 keys in Secrets Manager (bootstrap.sh handles this)."
  echo "   See: docs/github-app-setup.md for the full walkthrough."
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
    warn "The DORA exporter and scaffolder templates require it for local dev."
    warn "For AWS/production, a GitHub App (docs/github-app-setup.md) is recommended instead."
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
  # setup.sh already ran the manifest-driven sed pass above — tell bootstrap-local.sh
  # to skip _apply_personalization so we don't repeat a ~700-file scan.
  IDP_PERSONALIZATION_DONE=1 "${ROOT_DIR}/scripts/bootstrap-local.sh"

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
# PHASE 2B — AWS single-region bootstrap
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

  # ── Terraform state backend ─────────────────────────────────────────────────
  # Must come before any terraform init. Terraform cannot create the bucket its
  # own backend lives in, so this is provisioned with the AWS CLI first.
  log "Preparing the Terraform state backend..."
  ensure_tf_state_backend "${AWS_REGION}" "${CLUSTER_NAME}"

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
  step "Bootstrapping AWS EKS platform (single-region)..."
  log "Running scripts/bootstrap.sh (this takes 40–70 minutes)..."
  "${ROOT_DIR}/scripts/bootstrap.sh" \
    --region "${AWS_REGION}" \
    --cluster-name "${CLUSTER_NAME}"

  # ── Summary ──────────────────────────────────────────────────────────────────
  step "Done!"
  echo ""
  echo -e "${GREEN}✓ AWS IDP platform provisioned (single-region).${RESET}"
  echo ""
  echo -e "${BOLD}Next steps:${RESET}"
  echo "  1. Verify EKS cluster:  kubectl get nodes"
  echo "  2. Open Backstage:      kubectl get ingress -n backstage"
  echo "  3. Push first image:    git push origin main  (triggers GitHub Actions CI/CD)"
  echo ""
  echo -e "${BOLD}Day-2 tools:${RESET}"
  echo "  Scaffold a service:    idp scaffold service --name my-svc --type nodejs"
  echo "  Scaffold a test suite: idp scaffold test-suite --name my-e2e --type playwright --service my-svc"
  echo "  Register a CI runner:  ./scripts/setup-runner.sh --repo <repo-name>"
  echo ""
  echo -e "${BOLD}Upgrade to multi-region later:${RESET}"
  echo "  ./scripts/bootstrap-multiregion.sh --skip-global  # adds standby cluster"
  echo ""
  echo "  Commit your personalised repo:"
  echo "    git add . && git commit -m 'chore: initialise from backstage-platform-template'"
  echo ""
}

# ════════════════════════════════════════════════════════════════════════════════
# PHASE 2C — AWS multi-region active-standby bootstrap
# ════════════════════════════════════════════════════════════════════════════════

_bootstrap_aws_multiregion() {
  step "Phase 2C — AWS multi-region bootstrap (active-standby)"

  # ── Pre-flight ──────────────────────────────────────────────────────────────
  log "Checking required tools..."
  local missing=()
  for cmd in aws terraform kubectl helm docker jq argocd; do
    command -v "$cmd" &>/dev/null || missing+=("$cmd")
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    err "Missing required tools: ${missing[*]}
Install them and re-run, or run directly:
  ./scripts/bootstrap-multiregion.sh"
  fi

  log "Verifying AWS credentials..."
  aws sts get-caller-identity &>/dev/null \
    || err "AWS credentials not configured. Run 'aws configure' or set AWS_PROFILE and retry."

  local caller
  caller=$(aws sts get-caller-identity --query 'Arn' --output text)
  log "Authenticated as: ${caller}"

  # ── Review per-region tfvars ────────────────────────────────────────────────
  echo ""
  echo -e "${BOLD}Multi-region topology:${RESET}"
  echo "  Primary (active)  : eu-central-1  — terraform/tfvars/eu-central-1.tfvars"
  echo "  Standby (DR)      : us-east-1     — terraform/tfvars/us-east-1.tfvars"
  echo "  Global module     : terraform/global/ (KMS, Route53, TGW, Aurora Global, CloudFront)"
  echo ""
  warn "Review both tfvars files and terraform/global/terraform.tfvars before proceeding."
  warn "At minimum confirm: cluster_name, vpc_cidr (must not overlap), rds_instance_class."
  echo ""
  read -rp "$(echo -e "${CYAN}Have you reviewed the tfvars and are ready to proceed?${RESET} [y/N] ")" MR_READY
  [[ "${MR_READY}" =~ ^[Yy]$ ]] || { echo "Aborted. Edit the tfvars files and re-run."; exit 0; }

  # ── Optional flags ──────────────────────────────────────────────────────────
  echo ""
  echo "Bootstrap options (press Enter to accept defaults):"
  read -rp "$(echo -e "${CYAN}Skip global Terraform module (if already applied)?${RESET} [y/N] ")" _SKIP_GL
  read -rp "$(echo -e "${CYAN}Skip standby cluster provisioning (primary only)?${RESET} [y/N] ")" _SKIP_SB
  read -rp "$(echo -e "${CYAN}Skip observability stack (Thanos, Grafana)?${RESET} [y/N] ")" _SKIP_OB
  read -rp "$(echo -e "${CYAN}Skip AI/ML platform (KAgent, MLflow)?${RESET} [y/N] ")" _SKIP_AI

  local mr_flags=()
  [[ "${_SKIP_GL}" =~ ^[Yy]$ ]] && mr_flags+=(--skip-global)
  [[ "${_SKIP_SB}" =~ ^[Yy]$ ]] && mr_flags+=(--skip-standby)
  [[ "${_SKIP_OB}" =~ ^[Yy]$ ]] && mr_flags+=(--skip-obs)
  [[ "${_SKIP_AI}" =~ ^[Yy]$ ]] && mr_flags+=(--skip-ai)

  # ── Bootstrap multi-region ──────────────────────────────────────────────────
  step "Bootstrapping V2 multi-region platform (this takes 30–50 minutes)..."
  "${ROOT_DIR}/scripts/bootstrap-multiregion.sh" \
    --primary-region "${AWS_REGION:-eu-central-1}" \
    --standby-region "us-east-1" \
    "${mr_flags[@]}"

  # ── Summary ──────────────────────────────────────────────────────────────────
  step "Done!"
  echo ""
  echo -e "${GREEN}✓ V2 multi-region platform provisioned.${RESET}"
  echo ""
  echo -e "${BOLD}Next steps:${RESET}"
  echo "  1. Set Slack token:    kubectl edit secret argocd-notifications-secret -n argocd --context hub"
  echo "  2. Test failover:      argo submit aws/argo-workflows/failover-runbook.yaml --context hub"
  echo "  3. Read the DR guide:  docs/multi-region.md"
  echo ""
  echo -e "${BOLD}Day-2 tools:${RESET}"
  echo "  Scaffold a service:    idp scaffold service --name my-svc --type nodejs"
  echo "  Multi-region template: Backstage → Templates → EKS Multi-Region"
  echo "  Register a CI runner:  ./scripts/setup-runner.sh --repo <repo-name>"
  echo ""
  echo "  Commit your personalised repo:"
  echo "    git add . && git commit -m 'chore: initialise from backstage-platform-template (multi-region)'"
  echo ""
}

# ════════════════════════════════════════════════════════════════════════════════
# MAIN
# ════════════════════════════════════════════════════════════════════════════════

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║     backstage-platform-template  ·  Setup         ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════════════╝${RESET}"
echo ""
echo "This script personalises your copy of the template and optionally"
echo "bootstraps the full platform end-to-end."
echo ""

# ════════════════════════════════════════════════════════════════════════════════
# PHASE 0 — Personalisation
# ════════════════════════════════════════════════════════════════════════════════

step "Phase 0 — Personalisation"

# ── Gather inputs (manifest-driven) ──────────────────────────────────────────
# All prompts come from scripts/placeholders.conf. To add a new variable, add a
# row to the manifest — no code change needed.

load_placeholder_manifest    # populates MANIFEST_* parallel arrays (see lib.sh)

VALUES=()   # parallel to MANIFEST_NAMES — user-supplied (or fallback) values

for i in "${!MANIFEST_NAMES[@]}"; do
  name="${MANIFEST_NAMES[$i]}"
  placeholder="${MANIFEST_PLACEHOLDERS[$i]}"
  default="${MANIFEST_DEFAULTS[$i]}"
  prompt="${MANIFEST_PROMPTS[$i]}"
  required="${MANIFEST_REQUIREDS[$i]}"

  default_display=""
  [[ -n "$default" ]] && default_display=" [${default}]"
  read -rp "$(echo -e "${CYAN}${prompt}${RESET}${default_display}: ")" val

  if [[ -z "$val" ]]; then
    if [[ "$required" == "yes" ]]; then
      err "${name} is required."
    fi
    # Use prompt default if provided, otherwise keep the placeholder unchanged
    val="${default:-$placeholder}"
  fi
  VALUES[$i]="$val"
  # Also export as a named bash variable so existing code that reads
  # $GITHUB_ORG, $AWS_REGION, etc. continues to work.
  printf -v "$name" '%s' "$val"
  export "$name"
done

# Derived: Backstage OAuth callback URL (display-only, not a placeholder).
BACKSTAGE_URL="${BACKSTAGE_URL:-http://localhost:3000}"
BACKSTAGE_CALLBACK_URL="${BACKSTAGE_URL}/api/auth/github/handler/frame"

# ── Confirmation ─────────────────────────────────────────────────────────────

echo ""
echo -e "${YELLOW}Will replace:${RESET}"
for i in "${!MANIFEST_NAMES[@]}"; do
  printf "  %-22s → %s\n" "${MANIFEST_PLACEHOLDERS[$i]}" "${VALUES[$i]}"
done
echo "  (plus the \${{ YOUR_* }} Jinja form and any hardcoded fallbacks listed in the manifest)"
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

timer_start "Personalisation (sed pass)"

# Shared with bootstrap-local.sh's day-2 personalisation reruns — see
# scripts/lib.sh. Reads resolved values from the MANIFEST_NAMES-exported shell
# variables set in the prompt loop above, and sets TARGETS (the full candidate
# file list) for the _verify_no_remaining check below.
run_personalization_pass
TARGETS="$PERSONALIZATION_TARGETS"

# Warn if any YOUR_* placeholders remain. Excludes:
#   - .env.example files (intentional fill-in markers)
#   - skeleton/ paths    (Backstage Nunjucks templates may keep YOUR_* for output)
#   - placeholders.conf  (the manifest itself)
#   - .terraform/        (downloaded provider binaries match the pattern by coincidence)
#   - docs/ and README   (user-facing instructions legitimately reference YOUR_* tokens)
#
# Drops the excluded paths first, then runs ONE batched grep over what's left.
# This used to spawn a `grep` per file across the whole ~700-file candidate list
# — measured at ~8.8s on this repo, versus ~0.13s batched, for a check that is
# pure verification and changes nothing.
_verify_no_remaining() {
  local filtered remaining
  filtered=$(printf '%s\n' "$TARGETS" \
    | grep -v '^$' \
    | grep -v -e '\.env\.example$' \
              -e '/skeleton/' \
              -e '/placeholders\.conf$' \
              -e '/\.terraform/' \
              -e '/docs/' \
              -e '/README\.md$' || true)

  if [[ -z "$filtered" ]]; then
    log "All YOUR_* placeholders resolved."
    return 0
  fi

  remaining=$(printf '%s\n' "$filtered" \
    | tr '\n' '\0' \
    | LC_ALL=C xargs -0 grep -l 'YOUR_[A-Z_]*' 2>/dev/null || true)

  if [[ -n "$remaining" ]]; then
    warn "These files still contain YOUR_* placeholders — review manually:"
    while IFS= read -r f; do
      [[ -n "$f" ]] && warn "  $f"
    done <<< "$remaining"
  else
    log "All YOUR_* placeholders resolved."
  fi
}
timer_end "Personalisation (sed pass)"

timer_start "Verify placeholders"
_verify_no_remaining
timer_end "Verify placeholders"

# Write the single-source-of-truth file consumed by day-2 scripts.
# Values are double-quoted with embedded " escaped, so that `source .idp-config.env`
# works even when values contain spaces (e.g. DISPLAY_NAME="Jane Smith").
_write_idp_config() {
  local f="${ROOT_DIR}/.idp-config.env"
  {
    echo "# Generated by scripts/setup.sh — single source of truth for personalisation."
    echo "# Re-run setup.sh to regenerate. Read by scripts/bootstrap-local.sh and friends."
    for i in "${!MANIFEST_NAMES[@]}"; do
      local v="${VALUES[$i]}"
      # Escape backslash, dollar, backtick, and double-quote so `source` reads
      # the value verbatim regardless of shell metacharacters.
      v="${v//\\/\\\\}"
      v="${v//\"/\\\"}"
      v="${v//\$/\\\$}"
      v="${v//\`/\\\`}"
      echo "${MANIFEST_NAMES[$i]}=\"${v}\""
    done
  } > "$f"
  log "Wrote ${f}"
}
_write_idp_config

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

# Mirror GITHUB_ORG into local/backstage/.env so docker compose picks it up
# without needing --env-file local/.env on every command.
if [[ -f local/backstage/.env ]]; then
  _upsert_env "local/backstage/.env" "GITHUB_ORG" "${GITHUB_ORG}"
  log "Mirrored GITHUB_ORG to local/backstage/.env"
fi

# Build the idp CLI so it is ready immediately after setup
if command -v go &>/dev/null; then
  timer_start "Build idp CLI"
  step "Building idp CLI..."
  if (cd cli && go build -o ../bin/idp ./cmd/idp 2>/dev/null); then
    log "idp CLI built → ./bin/idp  (add $(pwd)/bin to PATH or run: make cli-install)"
  else
    warn "idp CLI build failed — run 'make cli-build' manually after fixing the error."
  fi
else
  warn "Go not found — skipping idp CLI build. Install Go then run: make cli-build"
fi
timer_end "Build idp CLI"

echo ""
echo -e "${GREEN}✓ Personalisation complete.${RESET}"

# ════════════════════════════════════════════════════════════════════════════════
# PHASE 1 — Mode selection
# ════════════════════════════════════════════════════════════════════════════════

echo ""
echo "What would you like to do next?"
echo "  local  — Bootstrap the full platform locally (Kind cluster, no AWS needed)"
echo "  aws    — Single-region AWS EKS (one cluster, simpler, good for evaluation)"
echo "  multi  — Multi-region AWS EKS: eu-central-1 (primary) + us-east-1 (standby DR)"
echo "  skip   — Stop here; run scripts manually when ready"
echo ""
read -rp "$(echo -e "${CYAN}Environment${RESET} [local/aws/multi/skip]: ")" SETUP_MODE
SETUP_MODE="${SETUP_MODE:-skip}"

# ════════════════════════════════════════════════════════════════════════════════
# Dispatch
# ════════════════════════════════════════════════════════════════════════════════

case "${SETUP_MODE}" in
  local) _bootstrap_local            ;;
  aws)   _bootstrap_aws              ;;
  multi) _bootstrap_aws_multiregion  ;;
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
