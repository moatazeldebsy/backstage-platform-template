#!/usr/bin/env bash
# check-go-coverage.sh — fail when a Go coverage profile's total statement
# coverage is below a floor.
#
# The floors in ci.yml are a ratchet, not a target (#166): each sits just under
# what the module measured when it was set, so CI blocks regressions without
# failing on day one. Raise a floor when coverage rises; never lower one to
# make a PR pass.
#
# Usage: ./scripts/check-go-coverage.sh <coverage.out> <min-percent>
set -euo pipefail

profile="${1:?usage: $0 <coverage.out> <min-percent>}"
min="${2:?usage: $0 <coverage.out> <min-percent>}"

[[ -f "$profile" ]] || { echo "error: coverage profile not found: $profile" >&2; exit 1; }

total=$(go tool cover -func="$profile" | awk '/^total:/ { sub("%", "", $NF); print $NF }')
[[ -n "$total" ]] || { echo "error: no total line in $profile" >&2; exit 1; }

if awk -v t="$total" -v m="$min" 'BEGIN { exit !(t + 0 < m + 0) }'; then
  echo "FAIL  coverage ${total}% is below the ${min}% floor (${profile})"
  exit 1
fi
echo "ok    coverage ${total}% (floor ${min}%)"
