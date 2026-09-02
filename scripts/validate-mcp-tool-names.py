#!/usr/bin/env python3
"""Assert MCP tool names are unique across all servers.

The AI gateway (kubernetes/ml-platform/ai-gateway.yaml) multiplexes all eight
MCP servers behind one endpoint with `prefixMode: never`, so a tool keeps the
name its own server gave it. That is deliberate: the alternative renames every
tool the moment a second target exists (`sync_app` -> `argocd_sync_app`), which
would invalidate the `toolNames:` allowlist and the tool documentation inside
the systemMessage of all nine agents in kubernetes/kagent/.

`never` is only safe while names are unique. If two servers ever expose the same
name, the gateway routes by name lookup and one of them wins silently — the
agent calls a tool and reaches the wrong server. Nothing errors.

So this is the standing guard on that assumption. If it ever fails, the choice
is to rename the colliding tool or to switch prefixMode and pay the nine-agent
migration; do not simply delete the check.

Run:  python3 scripts/validate-mcp-tool-names.py
"""

from __future__ import annotations

import re
import sys
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# Every server registers with the multi-line form:
#     server.tool(
#       'tool_name',
# `srv` is accepted too — contract-mcp-server uses a different receiver name.
TOOL_RE = re.compile(
    r"\b(?:server|srv)\.tool\(\s*['\"](?P<name>[A-Za-z0-9_]+)['\"]",
    re.DOTALL,
)


def collect() -> dict[str, set[str]]:
    """tool name -> set of servers registering it."""
    owners: dict[str, set[str]] = defaultdict(set)
    for svc in sorted((REPO / "services").glob("*-mcp-server")):
        src = svc / "src"
        if not src.is_dir():
            continue
        for path in sorted(src.rglob("*.ts")):
            # __tests__ register throwaway tools; they are not served.
            if "__tests__" in path.parts:
                continue
            for match in TOOL_RE.finditer(path.read_text(encoding="utf-8")):
                owners[match.group("name")].add(svc.name)
    return owners


def main() -> int:
    owners = collect()
    if not owners:
        print("No MCP tool registrations found — nothing to check.", file=sys.stderr)
        return 1

    collisions = {name: srv for name, srv in owners.items() if len(srv) > 1}
    if collisions:
        print(
            f"MCP tool name collisions ({len(collisions)}) — "
            "the gateway multiplexes with prefixMode: never, so these would "
            "route to whichever server wins the name lookup:\n",
            file=sys.stderr,
        )
        for name, servers in sorted(collisions.items()):
            print(f"  ::error::'{name}' registered by {sorted(servers)}", file=sys.stderr)
        print(
            "\nRename the tool, or change prefixMode in "
            "kubernetes/ml-platform/ai-gateway.yaml and migrate the toolNames "
            "allowlists and systemMessage text in kubernetes/kagent/.",
            file=sys.stderr,
        )
        return 1

    per_server: dict[str, int] = defaultdict(int)
    for servers in owners.values():
        per_server[next(iter(servers))] += 1
    summary = ", ".join(f"{s.replace('-mcp-server', '')}={n}" for s, n in sorted(per_server.items()))
    print(f"{len(owners)} MCP tools, all unique across {len(per_server)} servers ({summary}).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
