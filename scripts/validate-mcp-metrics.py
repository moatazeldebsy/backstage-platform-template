#!/usr/bin/env python3
"""Validate the MCP metrics label contract.

`src/telemetry.ts` is guarded against drift by the `mcp-telemetry-drift` CI job,
but the Prometheus metric declarations live in each server's own `server.ts` /
`index.ts` and had no guard at all. They drifted, in both directions:

  * `qa-mcp-server` declared `mcp_tool_calls_total` with labelNames
    ['server', 'tool'] — no `outcome`. Every consumer that selects
    `{outcome="success"}` (the Engineering Intelligence scorer) or
    `{outcome="error"}` (the MCPToolErrorRate alert) silently skipped qa.
  * Both AI dashboards selected `{status="error"}`. No server has ever emitted a
    `status` label, so that panel read 0 for its whole life.

Neither failure is visible: a wrong label name does not error, it just matches
nothing. So this checks both ends of the contract —

  1. every MCP server declares the canonical label set, and
  2. every consumer selects only labels that exist.

Run:  python3 scripts/validate-mcp-metrics.py
Exits non-zero and prints every violation on failure.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# The canonical label set for mcp_tool_calls_total. `server` and `tool` identify
# the call; `outcome` is what makes success/error ratios expressible at all.
CANONICAL = {"server", "tool", "outcome"}

# Metrics whose selectors are checked against CANONICAL. mcp_tool_duration_*
# deliberately carries only server+tool — an errored call has no meaningful
# duration, so it is not in this map.
CHECKED_METRIC = "mcp_tool_calls_total"

# Where consumers of the metric live. Dashboards, alert rules, and the
# Engineering Intelligence Prometheus client.
CONSUMER_GLOBS = (
    "kubernetes/monitoring/*.yaml",
    "observability/grafana/dashboards/**/*.json",
    "observability/alertmanager/*.yaml",
    "backstage/app/packages/backend/src/modules/engineeringIntelligence/*.ts",
)

# `new Counter({ ... name: 'mcp_tool_calls_total' ... labelNames: [...] })`,
# tolerating the one-line and the multi-line spelling both are written in.
COUNTER_RE = re.compile(
    r"new\s+Counter\s*\(\s*\{(?P<body>.*?)\}\s*\)",
    re.DOTALL,
)
LABELNAMES_RE = re.compile(r"labelNames\s*:\s*\[(?P<labels>[^\]]*)\]")
NAME_RE = re.compile(r"name\s*:\s*['\"](?P<name>[^'\"]+)['\"]")

# `mcp_tool_calls_total{foo="bar",baz=~"x"}` in a PromQL string, including the
# JSON-escaped \" form dashboards embed.
SELECTOR_RE = re.compile(CHECKED_METRIC + r"\{(?P<sel>[^}]*)\}")
LABEL_IN_SELECTOR_RE = re.compile(r"([A-Za-z_][A-Za-z0-9_]*)\s*(?:=~|!~|!=|=)")


def server_dirs() -> list[Path]:
    return sorted(p for p in (REPO / "services").glob("*-mcp-server") if p.is_dir())


def check_declarations() -> list[str]:
    """Every MCP server must declare mcp_tool_calls_total with CANONICAL."""
    errors: list[str] = []
    for svc in server_dirs():
        found = False
        for src in sorted((svc / "src").glob("*.ts")):
            text = src.read_text(encoding="utf-8")
            for match in COUNTER_RE.finditer(text):
                body = match.group("body")
                name = NAME_RE.search(body)
                if not name or name.group("name") != CHECKED_METRIC:
                    continue
                found = True
                labels_match = LABELNAMES_RE.search(body)
                labels = set()
                if labels_match:
                    labels = {
                        lbl.strip().strip("'\"")
                        for lbl in labels_match.group("labels").split(",")
                        if lbl.strip()
                    }
                if labels != CANONICAL:
                    rel = src.relative_to(REPO)
                    errors.append(
                        f"{rel}: {CHECKED_METRIC} declares labelNames "
                        f"{sorted(labels)}, expected {sorted(CANONICAL)}"
                    )
        if not found:
            errors.append(
                f"services/{svc.name}: no {CHECKED_METRIC} declaration found — "
                "every MCP server must emit it or it drops out of the AI dashboards"
            )
    return errors


def check_consumers() -> list[str]:
    """No consumer may select a label the servers do not emit."""
    errors: list[str] = []
    for pattern in CONSUMER_GLOBS:
        for path in sorted(REPO.glob(pattern)):
            if not path.is_file():
                continue
            # Dashboards embed PromQL inside JSON strings, so \" reaches us
            # escaped; normalise before matching.
            text = path.read_text(encoding="utf-8").replace('\\"', '"')
            for match in SELECTOR_RE.finditer(text):
                for label in LABEL_IN_SELECTOR_RE.findall(match.group("sel")):
                    if label not in CANONICAL:
                        rel = path.relative_to(REPO)
                        errors.append(
                            f"{rel}: selects {CHECKED_METRIC}{{{label}=...}}, "
                            f"but no server emits a '{label}' label "
                            f"(emitted: {sorted(CANONICAL)})"
                        )
    return errors


def check_dashboards_parse() -> list[str]:
    """A dashboard that does not parse cannot be reviewed for the above."""
    errors: list[str] = []
    for path in sorted(REPO.glob("observability/grafana/dashboards/**/*.json")):
        try:
            json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            errors.append(f"{path.relative_to(REPO)}: invalid JSON — {exc}")
    return errors


def main() -> int:
    servers = server_dirs()
    if not servers:
        print("No services/*-mcp-server directories found — nothing to check.")
        return 0

    errors = check_declarations() + check_consumers() + check_dashboards_parse()

    if errors:
        print(f"MCP metrics contract violations ({len(errors)}):\n", file=sys.stderr)
        for err in errors:
            print(f"  ::error::{err}", file=sys.stderr)
        print(
            "\nThe canonical label set is "
            f"{sorted(CANONICAL)} for {CHECKED_METRIC}. A label mismatch never "
            "raises — it just matches nothing — which is why this is a gate.",
            file=sys.stderr,
        )
        return 1

    print(
        f"{CHECKED_METRIC}: {len(servers)} servers declare {sorted(CANONICAL)}; "
        "all consumer selectors use emitted labels."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
