# mcp-common

The source of truth for code that every MCP server carries a copy of.

Right now that is one file: `src/telemetry.ts`, the OpenTelemetry + Prometheus
setup shared by all eight servers.

## Why copies at all

This is **not** an npm package, and deliberately so. Each MCP server builds from
its own directory with its own `Dockerfile` and `package-lock.json`; a workspace
dependency would mean either publishing to a registry or teaching eight
Dockerfiles to copy a sibling directory into their build context. Both are more
machinery than one 289-line file justifies.

So the copies stay, and CI makes divergence impossible instead.

## Changing telemetry.ts

Edit **`services/mcp-common/src/telemetry.ts`**, then:

```bash
./scripts/sync-mcp-common.sh
```

That overwrites every server's copy from this one. Commit the whole set
together — the `mcp-telemetry-drift` CI job fails the build if any copy differs
from this one.

`--check` verifies without writing, which is what CI runs:

```bash
./scripts/sync-mcp-common.sh --check
```

## What is *not* guarded here

The Prometheus metric **declarations** live in each server's own
`server.ts`/`index.ts`, not in `telemetry.ts`, so this file being identical
everywhere says nothing about the metrics contract. That is
`scripts/validate-mcp-metrics.py`'s job — it exists because `qa-mcp-server`
declared `mcp_tool_calls_total` without the `outcome` label and went unnoticed.
