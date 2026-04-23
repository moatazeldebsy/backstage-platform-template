#!/usr/bin/env bash
# One-time setup: replaces YOUR_GITHUB_ORG, YOUR_AWS_ACCOUNT_ID, and other
# placeholders with your real values throughout the repo.
set -euo pipefail

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RESET='\033[0m'

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║     backstage-idp-starter  ·  Setup         ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════════════╝${RESET}"
echo ""
echo "This script personalises your copy of the template."
echo "Run it once, then commit the result to your own repo."
echo ""

# ── Gather inputs ────────────────────────────────────────────────────────────

read -rp "$(echo -e "${CYAN}GitHub org or username${RESET} (e.g. acme-corp): ")" GITHUB_ORG
GITHUB_ORG="${GITHUB_ORG:-YOUR_GITHUB_ORG}"

read -rp "$(echo -e "${CYAN}AWS Account ID${RESET} (12 digits, leave blank to skip): ")" AWS_ACCOUNT_ID
AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:-YOUR_AWS_ACCOUNT_ID}"

read -rp "$(echo -e "${CYAN}AWS Region${RESET} [us-east-1]: ")" AWS_REGION
AWS_REGION="${AWS_REGION:-us-east-1}"

read -rp "$(echo -e "${CYAN}EKS cluster name${RESET} [idp-mvp]: ")" CLUSTER_NAME
CLUSTER_NAME="${CLUSTER_NAME:-idp-mvp}"

echo ""
echo -e "${YELLOW}Will replace:${RESET}"
echo "  YOUR_GITHUB_ORG      → ${GITHUB_ORG}"
echo "  YOUR_AWS_ACCOUNT_ID  → ${AWS_ACCOUNT_ID}"
echo "  us-east-1            → ${AWS_REGION}"
echo "  idp-mvp (cluster)    → ${CLUSTER_NAME}"
echo ""
read -rp "Proceed? [y/N] " CONFIRM
[[ "${CONFIRM}" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }

# ── Find-replace ─────────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}Applying substitutions...${RESET}"

# Collect text files (skip binary, git internals, and this script itself)
TARGETS=$(LC_ALL=C find . -type f \
  ! -path './.git/*' \
  ! -name 'setup.sh' \
  ! -name '*.png' ! -name '*.jpg' ! -name '*.jpeg' ! -name '*.ico' \
  ! -name '*.woff' ! -name '*.woff2' ! -name '*.ttf' ! -name '*.eot' \
  ! -name '*.gz' ! -name '*.zip' ! -name '*.tar' \
  2>/dev/null)

_sed() {
  # macOS (BSD sed) requires an explicit backup suffix with -i; use '' for no backup
  if sed --version 2>&1 | grep -q GNU; then
    sed -i "$@"
  else
    sed -i '' "$@"
  fi
}

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

# ── Bootstrap env files ───────────────────────────────────────────────────────

if [[ -f local/.env.example && ! -f local/.env ]]; then
  cp local/.env.example local/.env
  echo "Created local/.env from local/.env.example — fill in your tokens."
fi

if [[ -f local/backstage/.env.example && ! -f local/backstage/.env ]]; then
  cp local/backstage/.env.example local/backstage/.env
  echo "Created local/backstage/.env from local/backstage/.env.example — fill in your tokens."
fi

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}✓ Setup complete!${RESET}"
echo ""
echo -e "${BOLD}Next steps:${RESET}"
echo "  1. Fill in secrets in local/.env and local/backstage/.env"
echo "  2. Start the local platform:"
echo "       ./scripts/bootstrap-local.sh"
echo "  3. (AWS) Configure Terraform:"
echo "       cd terraform && cp terraform.tfvars.example terraform.tfvars"
echo "       # edit terraform.tfvars, then:"
echo "       terraform init && terraform apply"
echo "  4. Commit your personalised repo:"
echo "       git add . && git commit -m 'chore: initialise from backstage-idp-starter'"
echo ""
echo "Full docs: docs/ or run  make docs-serve  after setup."
echo ""
