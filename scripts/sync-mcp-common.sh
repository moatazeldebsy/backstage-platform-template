#!/usr/bin/env bash
# sync-mcp-common.sh — push services/mcp-common/src/* out to every MCP server.
#
# Eight MCP servers each carry a byte-identical copy of telemetry.ts. They are
# copies rather than a shared package on purpose: each server builds from its own
# directory with its own Dockerfile and package-lock.json, so a workspace
# dependency would mean publishing to a registry or teaching eight Dockerfiles to
# reach outside their build context — more machinery than one 289-line file earns.
#
# The trade is that copies drift. This script is the "write" half of not letting
# them: edit services/mcp-common/src/telemetry.ts, run this, commit the lot.
# The `mcp-telemetry-drift` CI job runs `--check` and fails if any copy differs.
#
# Usage:
#   ./scripts/sync-mcp-common.sh            # overwrite every server's copy
#   ./scripts/sync-mcp-common.sh --check    # report drift, write nothing (CI)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="${REPO_ROOT}/services/mcp-common/src"

CHECK=false
[[ "${1:-}" == "--check" ]] && CHECK=true

[[ -d "$SRC_DIR" ]] || { echo "error: $SRC_DIR does not exist" >&2; exit 1; }

# Every services/*-mcp-server with a src/ dir. Discovered rather than listed, so
# a ninth server is picked up by existing here, not by editing this script.
#
# while-read rather than `mapfile`: this script is meant to be run by hand, and
# macOS still ships bash 3.2, which has no mapfile. The CI job can afford it;
# a developer's laptop cannot.
SERVERS=()
while IFS= read -r d; do
  SERVERS+=("$d")
done < <(find "${REPO_ROOT}/services" -maxdepth 1 -type d -name '*-mcp-server' | sort)
[[ ${#SERVERS[@]} -gt 0 ]] || { echo "error: no *-mcp-server directories found" >&2; exit 1; }

drift=0
synced=0

for src in "$SRC_DIR"/*; do
  [[ -f "$src" ]] || continue
  file="$(basename "$src")"
  for server in "${SERVERS[@]}"; do
    dest="${server}/src/${file}"
    name="services/$(basename "$server")/src/${file}"

    # A server that never had the file does not silently acquire one — that
    # would be this script inventing a dependency rather than syncing a copy.
    if [[ ! -f "$dest" ]]; then
      echo "skip   ${name} (no existing copy)"
      continue
    fi

    if cmp -s "$src" "$dest"; then
      continue
    fi

    if $CHECK; then
      echo "DRIFT  ${name}"
      diff -u "$dest" "$src" | head -40 || true
      drift=$((drift + 1))
    else
      cp "$src" "$dest"
      echo "synced ${name}"
      synced=$((synced + 1))
    fi
  done
done

if $CHECK; then
  if [[ $drift -gt 0 ]]; then
    echo
    echo "::error::${drift} copy/copies differ from services/mcp-common/src/." \
         "Edit the mcp-common copy and run ./scripts/sync-mcp-common.sh."
    exit 1
  fi
  echo "All MCP server copies match services/mcp-common/src/."
else
  if [[ $synced -eq 0 ]]; then
    echo "Already in sync — nothing to write."
  else
    echo
    echo "${synced} file(s) updated. Commit them together with the mcp-common change."
  fi
fi
