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
}
