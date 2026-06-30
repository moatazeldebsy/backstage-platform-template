#!/usr/bin/env bash
# WeAreDevelopers World Congress — Contract Testing with MCP
# Demo script: runs all 4 beats via kagent CLI.
#
# Usage:
#   ./scripts/demo-kagent.sh              # interactive — waits for ENTER between beats
#   ./scripts/demo-kagent.sh --auto       # auto-advance after each beat (for recording)
#
# What it does:
#   Beat 0  — start port-forward + seed contracts
#   Beat 1  — can_i_deploy 1.0.0 → safe: true
#   Beat 2  — register broken v1.1.0 (currency → currencyCode)
#   Beat 3  — can_i_deploy 1.1.0 → safe: false, breaking changes
#   Beat 4  — generate migration guide 1.0.0 → 1.1.0

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KAGENT_URL="${KAGENT_URL:-http://localhost:8083}"
CONTRACT_SERVER_URL="${CONTRACT_SERVER_URL:-http://contract-mcp-server.idp.local}"
AUTO="${1:-}"

# ── colours ──────────────────────────────────────────────────────────────────
BOLD=$'\033[1m'
DIM=$'\033[2m'
CYAN=$'\033[36m'
GREEN=$'\033[32m'
YELLOW=$'\033[33m'
RED=$'\033[31m'
RESET=$'\033[0m'

# ── helpers ───────────────────────────────────────────────────────────────────

header() {
  echo ""
  echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo -e "${CYAN}${BOLD}  $*${RESET}"
  echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo ""
}

subheader() {
  echo -e "${BOLD}  ▶ $*${RESET}"
  echo ""
}

pause() {
  if [[ "$AUTO" != "--auto" ]]; then
    echo ""
    echo -e "${DIM}  Press ENTER to continue...${RESET}"
    read -r
  else
    sleep 2
  fi
}

run_agent() {
  local task="$1"
  echo -e "${DIM}  \$ kagent invoke --agent contract-assistant \\${RESET}"
  echo -e "${DIM}      --task \"${task}\"${RESET}"
  echo ""

  local result
  result=$(kagent invoke \
    --agent contract-assistant \
    --task "$task" \
    --kagent-url "$KAGENT_URL" 2>&1)

  local text
  text=$(echo "$result" | python3 -c "
import sys, json
data = json.load(sys.stdin)
parts = data.get('artifacts', [{}])[0].get('parts', [{}])
text = next((p.get('text','') for p in parts if p.get('kind') == 'text'), '')
print(text)
" 2>/dev/null || echo "$result")

  # render markdown-ish output: bold headers, preserve tables
  printf '%s\n' "$text" | sed \
    -e "s/\*\*\([^*]*\)\*\*/${BOLD}\1${RESET}/g" \
    -e "s|^## |${BOLD}${CYAN}## ${RESET}|" \
    -e "s|^### |${BOLD}### ${RESET}|" \
    -e "s/✅/${GREEN}✅${RESET}/g" \
    -e "s/❌/${RED}❌${RESET}/g" \
    -e "s/⚠️/${YELLOW}⚠️${RESET}/g"
  echo ""
}

# ── port-forward ──────────────────────────────────────────────────────────────

ensure_port_forward() {
  if curl -sf "$KAGENT_URL/health" &>/dev/null; then
    echo -e "  ${GREEN}✓${RESET} kagent-controller reachable at $KAGENT_URL"
    return
  fi

  echo -e "  Starting port-forward to kagent-controller..."
  kubectl port-forward svc/kagent-controller 8083:8083 -n kagent \
    &>/tmp/pf-kagent.log &
  local pf_pid=$!

  local i=0
  while ! curl -sf "$KAGENT_URL/health" &>/dev/null; do
    sleep 1
    ((i++))
    if (( i > 15 )); then
      echo -e "  ${RED}✗${RESET} Timed out waiting for kagent-controller port-forward"
      kill "$pf_pid" 2>/dev/null || true
      exit 1
    fi
  done
  echo -e "  ${GREEN}✓${RESET} Port-forward ready (PID $pf_pid)"
}

# ═════════════════════════════════════════════════════════════════════════════
# MAIN
# ═════════════════════════════════════════════════════════════════════════════

echo ""
echo -e "${BOLD}Contract Testing with MCP — Live Demo${RESET}"
echo -e "${DIM}WeAreDevelopers World Congress · July 9 2026${RESET}"
echo ""

# ── Beat 0: preflight ─────────────────────────────────────────────────────────
header "PREFLIGHT: Seeding demo contracts"

ensure_port_forward
echo ""
CONTRACT_SERVER_URL="$CONTRACT_SERVER_URL" bash "$SCRIPT_DIR/seed-demo-contracts.sh"

pause

# ── Beat 1: happy path ────────────────────────────────────────────────────────
header "BEAT 1 — Happy Path: safe to deploy"

subheader "Ask the AI agent: can we deploy payments-api v1.0.0?"

run_agent "Can I deploy payments-api version 1.0.0?"

echo -e "  ${DIM}What just happened: agent called can_i_deploy tool → checked all registered"
echo -e "  consumer contracts → no breaking changes → safe: true${RESET}"

pause

# ── Beat 2: break the API ─────────────────────────────────────────────────────
header "BEAT 2 — Breaking Change: rename currency → currencyCode"

subheader "Register payments-api v1.1.0 (the field is renamed in the spec)"

CONTRACT_SERVER_URL="$CONTRACT_SERVER_URL" bash "$SCRIPT_DIR/break-payments-api.sh"

echo ""
echo -e "  ${DIM}In a real workflow this is a git diff caught by the CI contract-check job."
echo -e "  Here we register the new spec directly so the agent can check it live.${RESET}"

pause

# ── Beat 3: agent catches it ──────────────────────────────────────────────────
header "BEAT 3 — AI Agent Catches the Breaking Change"

subheader "Ask the AI agent: can we deploy payments-api v1.1.0?"

run_agent "Can I deploy payments-api version 1.1.0? List which consumers are blocked and why."

echo -e "  ${DIM}The agent called can_i_deploy and detect_breaking_changes."
echo -e "  Both payments-svc and billing-export expect 'currency' — it's gone in v1.1.0.${RESET}"

pause

# ── Beat 4: migration guide ───────────────────────────────────────────────────
header "BEAT 4 — Generate a Migration Guide"

subheader "Ask the AI agent to produce a migration guide"

run_agent "Generate a migration guide for payments-api from version 1.0.0 to version 1.1.0. Include the breaking changes and what each consumer needs to update."

echo -e "  ${DIM}The agent called generate_migration_guide — structured markdown, ready to"
echo -e "  paste into the PR description or the service's changelog.${RESET}"

echo ""
echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${GREEN}${BOLD}  Demo complete.${RESET}"
echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""
echo -e "  ${BOLD}Three things changed:${RESET}"
echo -e "  1. Developers stopped writing CI — the template ships it."
echo -e "  2. The breaking-change conversation moved from Slack thread to a PreSync job."
echo -e "  3. Every team sees the same contract registry the platform team sees."
echo ""
