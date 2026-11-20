#!/usr/bin/env bash
# Claude Code PostToolUse hook (Edit|Write|MultiEdit): fast lint for the edited file.
# Exit 2 sends stderr back to Claude so it fixes the problem; exit 0 otherwise.
# Missing tools are skipped, never treated as failures.
set -uo pipefail

file=$(jq -r '.tool_input.file_path // empty')
[ -n "$file" ] && [ -f "$file" ] || exit 0

root=$(git -C "$(dirname "$file")" rev-parse --show-toplevel 2>/dev/null) || exit 0
rel=${file#"$root"/}
cd "$root" || exit 0

have() { command -v "$1" >/dev/null 2>&1; }

run() {
  local out
  if ! out=$("$@" 2>&1); then
    printf 'Lint failed for %s:\n$ %s\n%s\n' "$rel" "$*" "$out" >&2
    exit 2
  fi
}

case "$rel" in
  *.sh)
    run bash -n "$file"
    have shellcheck && run shellcheck -S warning "$file" ;;
  cli/*.go)
    have go && run bash -c 'cd cli && go vet ./...' ;;
  services/hello-service/*.go)
    have go && run bash -c 'cd services/hello-service && go vet ./...' ;;
  *.py)
    have python3 && run python3 -m py_compile "$file" ;;
  helm/service-template/*)
    have helm && run helm lint helm/service-template ;;
  backstage/catalog/templates/*)
    have python3 && run python3 scripts/validate-catalog-templates.py ;;
  *.tf)
    have terraform && run terraform fmt -check -diff "$file" ;;
esac
exit 0
