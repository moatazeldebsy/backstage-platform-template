#!/usr/bin/env bash
# Claude Code Stop hook: before Claude finishes, run go test for any Go module
# with uncommitted changes. Exit 2 keeps Claude working until the tests pass.
# Other components (Backstage, Terraform) are left to CI to keep stops fast.
set -uo pipefail

input=$(cat)
# Don't loop forever: if we already blocked once this turn, let it stop.
[ "$(jq -r '.stop_hook_active // false' <<<"$input")" = "true" ] && exit 0

root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$root" || exit 0
command -v go >/dev/null 2>&1 || exit 0

changed=$( { git diff --name-only HEAD; git ls-files --others --exclude-standard; } 2>/dev/null)

for mod in cli services/hello-service; do
  grep -q "^$mod/.*\.go$\|^$mod/go\.\(mod\|sum\)$" <<<"$changed" || continue
  if ! out=$(cd "$mod" && go test ./... 2>&1); then
    printf 'go test failed in %s. Fix it before finishing:\n%s\n' "$mod" "$(tail -40 <<<"$out")" >&2
    exit 2
  fi
done
exit 0
