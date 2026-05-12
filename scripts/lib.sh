#!/usr/bin/env bash
# lib.sh — Shared helpers for IDP bootstrap scripts.
# Source this file; do not execute it directly.
[[ -n "${_IDP_LIB_LOADED:-}" ]] && return 0
_IDP_LIB_LOADED=1

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
RESET='\033[0m'

log()  { echo -e "[$(date +%T)] $*"; }
warn() { echo -e "[$(date +%T)] ${YELLOW}WARN${RESET}  $*"; }
err()  { echo -e "[$(date +%T)] ${RED}ERROR${RESET} $*" >&2; exit 1; }
step() { echo -e "\n${BOLD}▶ $*${RESET}"; }

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

_preflight_check_local() {
  local missing=()
  for cmd in kind kubectl helm docker; do
    command -v "$cmd" &>/dev/null || missing+=("$cmd")
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    err "Missing required tools: ${missing[*]}
Install them and re-run, or run manually:
  ./scripts/bootstrap-local.sh"
  fi
}
