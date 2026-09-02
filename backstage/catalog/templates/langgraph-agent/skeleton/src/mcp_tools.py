"""Load tools from the platform's MCP servers.

**No tool is reimplemented here.** The platform already runs eight MCP servers —
idp, qa, contract, github, cost, argocd, incident, security — reached through the
AI Gateway, which multiplexes all of them behind one endpoint. KAgent's
declarative agents consume the same gateway. A LangGraph app consuming it too is
the whole point: one set of platform capabilities, two ways to orchestrate them.

The trace propagation matters and is easy to get wrong. The MCP servers already
emit spans for their tool calls (`instrumentTools` in their `telemetry.ts`). If
this client does not send the W3C `traceparent` header, those spans land in
Langfuse as separate root traces and a run looks like several unrelated things
happening at once. Injecting the current context makes them children of the graph
node that called them.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from opentelemetry import propagate, trace

logger = logging.getLogger(__name__)

# Cached: building the client re-negotiates a session with every server, and the
# graph loads tools on more than one node per run.
_TOOLS_CACHE: list[Any] | None = None


def _endpoints() -> dict[str, str]:
    """MCP servers to load tools from.

    One entry: the AI Gateway, which multiplexes all eight platform MCP servers
    behind a single endpoint. Tool names come through unprefixed (the gateway
    runs `prefixMode: never`), so a tool is called by the name its own server
    gave it — `scaffold_service`, `sync_app`, `get_pr_diff` — exactly as the
    KAgent agents call it.

    This used to be a hand-maintained map of individual servers, and it had
    drifted to four of the eight: contract, argocd, incident and security were
    simply missing, so a scaffolded agent could not reach them and nothing said
    so. Pointing at the gateway removes the second copy of that knowledge rather
    than fixing it in two places forever.

    In-cluster Service DNS, not an ALB hostname: reachable from inside the
    cluster, no dependency on an ingress existing, and unaffected when an ALB
    hostname changes.
    """
    raw = os.environ.get("MCP_SERVERS", "")
    if raw:
        # "name=url,name=url" — lets a scaffolded app point at something else,
        # or narrow to a single server, without a code change.
        out: dict[str, str] = {}
        for pair in raw.split(","):
            if "=" in pair:
                name, url = pair.split("=", 1)
                out[name.strip()] = url.strip()
        return out

    ns = os.environ.get("MCP_GATEWAY_NAMESPACE", "ml-platform")
    return {
        "platform": f"http://ai-gateway.{ns}.svc.cluster.local:3000/mcp",
    }


def _trace_headers() -> dict[str, str]:
    """W3C traceparent for the current span, so MCP spans nest under this run."""
    headers: dict[str, str] = {}
    propagate.inject(headers)
    return headers


async def load_mcp_tools() -> list[Any]:
    """Return LangChain tools backed by the platform's MCP servers.

    Returns an empty list rather than raising when nothing is reachable. A
    core-only cluster has no MCP servers at all, and the agent should degrade to
    answering without tools rather than failing the request.
    """
    global _TOOLS_CACHE
    if _TOOLS_CACHE is not None:
        return _TOOLS_CACHE

    try:
        from langchain_mcp_adapters.client import MultiServerMCPClient
    except ImportError:
        logger.warning("langchain-mcp-adapters not installed — running without MCP tools")
        _TOOLS_CACHE = []
        return _TOOLS_CACHE

    connections = {
        name: {
            "transport": "streamable_http",
            "url": url,
            "headers": _trace_headers(),
        }
        for name, url in _endpoints().items()
    }

    try:
        client = MultiServerMCPClient(connections)
        tools = await client.get_tools()
        logger.info(
            "Loaded %d MCP tool(s) from %d server(s)", len(tools), len(connections)
        )
        _TOOLS_CACHE = tools
    except Exception:  # noqa: BLE001 - unreachable servers must not fail the request
        logger.exception("Could not load MCP tools — continuing without them")
        _TOOLS_CACHE = []

    return _TOOLS_CACHE


def current_trace_id() -> str:
    """Trace id of the active span, for correlating a reply with its Langfuse trace."""
    span = trace.get_current_span()
    ctx = span.get_span_context()
    return format(ctx.trace_id, "032x") if ctx and ctx.trace_id else ""
