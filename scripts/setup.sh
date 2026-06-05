#!/usr/bin/env bash
# scripts/setup.sh — One-time setup for backstage-platform-template.
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
  echo "       git add . && git commit -m 'chore: initialise from backstage-platform-template'"
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
  echo -e "${CYAN}3. Backstage auth secret${RESET} → set BACKSTAGE_AUTH_SECRET in local/backstage/.env"
  echo "   Any string works locally; for production use: openssl rand -hex 32"
  echo "   (Leave blank to use the built-in dev default.)"
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
  echo "    git add . && git commit -m 'chore: initialise from backstage-platform-template'"
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

# Derived: YOUR_ORG (legacy alias) → PACTFLOW_ORG if set, else GITHUB_ORG.
# Existing files may still reference YOUR_ORG; the dedicated YOUR_PACTFLOW_ORG
# placeholder is preferred for new files.
legacy_org="${PACTFLOW_ORG:-$GITHUB_ORG}"
MANIFEST_NAMES+=("ORG_LEGACY")
MANIFEST_PLACEHOLDERS+=("YOUR_ORG")
MANIFEST_DEFAULTS+=("")
MANIFEST_LITERALS+=("")
VALUES+=("$legacy_org")

# Derived: Backstage OAuth callback URL (display-only, not a placeholder).
BACKSTAGE_URL="${BACKSTAGE_URL:-http://localhost:3000}"
BACKSTAGE_CALLBACK_URL="${BACKSTAGE_URL}/api/auth/github/handler/frame"

# ── Confirmation ─────────────────────────────────────────────────────────────

echo ""
echo -e "${YELLOW}Will replace:${RESET}"
for i in "${!MANIFEST_NAMES[@]}"; do
  [[ "${MANIFEST_NAMES[$i]}" == "ORG_LEGACY" ]] && continue
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

log "Applying substitutions..."

# Build the file list. xargs cannot call shell functions, so we use a
# while-read loop in _replace_all instead.
TARGETS=$(LC_ALL=C find \
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
  -type f \
  ! -path '*/node_modules/*' \
  ! -path '*/.yarn/cache/*' \
  ! -path '*/dist/*' \
  ! -path '*/.terraform/*' \
  ! -name '*.png' ! -name '*.jpg' ! -name '*.jpeg' ! -name '*.ico' \
  ! -name '*.woff' ! -name '*.woff2' ! -name '*.ttf' ! -name '*.eot' \
  ! -name '*.gz' ! -name '*.zip' ! -name '*.tar' \
  2>/dev/null) || true

# Build a single bundled sed program (all -e expressions) and a grep pre-filter
# so that:
#   • each file is touched at most once by sed (one subprocess, not 30)
#   • files that contain NONE of the search strings are skipped entirely
# On a 700+ file TARGETS list this drops runtime from minutes to seconds.
SED_ARGS=()
NEEDLES=()
for i in "${!MANIFEST_NAMES[@]}"; do
  ph="${MANIFEST_PLACEHOLDERS[$i]}"
  v="${VALUES[$i]}"
  lit="${MANIFEST_LITERALS[$i]}"

  # Skip if user took no value (placeholder unchanged) — nothing to substitute
  [[ "$v" == "$ph" ]] && continue

  # Use | as sed delimiter (none of our values normally contain it).
  # Escape any literal | in the replacement just in case.
  v_esc="${v//|/\\|}"

  SED_ARGS+=(-e "s|${ph}|${v_esc}|g")
  SED_ARGS+=(-e "s|\${{ ${ph} }}|${v_esc}|g")
  NEEDLES+=("$ph")

  if [[ -n "$lit" && "$v" != "$lit" ]]; then
    # Escape regex metacharacters in the literal so we match it verbatim.
    lit_esc="$(printf '%s' "$lit" | sed 's|[][\\.^$*+?(){}/|]|\\&|g')"
    SED_ARGS+=(-e "s|${lit_esc}|${v_esc}|g")
    NEEDLES+=("$lit")
  fi
done

# Build a single ERE that matches ANY of the needles for the pre-filter pass.
NEEDLE_RE="$(IFS='|'; echo "${NEEDLES[*]}")"

_replace_all() {
  # Legacy single-pair entry point — still used for the YOUR_ORG legacy alias
  # appended after the manifest loop below.
  local pattern="$1" replacement="$2"
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    LC_ALL=C grep -qE "$pattern" "$f" 2>/dev/null || continue
    _sed "s|${pattern}|${replacement}|g" "$f" 2>/dev/null || true
  done <<< "$TARGETS"
}

# Bundled pass: one sed invocation per matching file, with ALL substitutions.
if [[ ${#SED_ARGS[@]} -gt 0 ]]; then
  scanned=0
  touched=0
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    scanned=$((scanned + 1))
    LC_ALL=C grep -qE "$NEEDLE_RE" "$f" 2>/dev/null || continue
    _sed "${SED_ARGS[@]}" "$f" 2>/dev/null || true
    touched=$((touched + 1))
  done <<< "$TARGETS"
  log "Substituted in ${touched} of ${scanned} files (skipped $((scanned - touched)) with no match)."
fi

# Warn if any YOUR_* placeholders remain. Excludes:
#   - .env.example files (intentional fill-in markers)
#   - skeleton/ paths    (Backstage Nunjucks templates may keep YOUR_* for output)
#   - placeholders.conf  (the manifest itself)
#   - .terraform/        (downloaded provider binaries match the pattern by coincidence)
#   - docs/ and README   (user-facing instructions legitimately reference YOUR_* tokens)
_verify_no_remaining() {
  local remaining=()
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    [[ "$f" == *.env.example ]] && continue
    [[ "$f" == */skeleton/* ]] && continue
    [[ "$f" == */placeholders.conf ]] && continue
    [[ "$f" == */.terraform/* ]] && continue
    [[ "$f" == */docs/* ]] && continue
    [[ "$f" == */README.md ]] && continue
    LC_ALL=C grep -ql 'YOUR_[A-Z_]*' "$f" 2>/dev/null && remaining+=("$f")
  done <<< "$TARGETS"
  if [[ ${#remaining[@]} -gt 0 ]]; then
    warn "These files still contain YOUR_* placeholders — review manually:"
    for f in "${remaining[@]}"; do warn "  $f"; done
  else
    log "All YOUR_* placeholders resolved."
  fi
}
_verify_no_remaining

# Write the single-source-of-truth file consumed by day-2 scripts.
# Values are double-quoted with embedded " escaped, so that `source .idp-config.env`
# works even when values contain spaces (e.g. DISPLAY_NAME="Jane Smith").
_write_idp_config() {
  local f="${ROOT_DIR}/.idp-config.env"
  {
    echo "# Generated by scripts/setup.sh — single source of truth for personalisation."
    echo "# Re-run setup.sh to regenerate. Read by scripts/bootstrap-local.sh and friends."
    for i in "${!MANIFEST_NAMES[@]}"; do
      [[ "${MANIFEST_NAMES[$i]}" == "ORG_LEGACY" ]] && continue
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
