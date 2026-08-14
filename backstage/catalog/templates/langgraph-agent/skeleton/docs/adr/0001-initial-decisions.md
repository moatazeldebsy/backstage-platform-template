# ADR-0001: Why a graph, and why these tools

**Status:** Accepted

## Context

This service could have been a single prompt call — the platform already has a
template for that (`llm-app-langfuse`). It is a graph instead.

## Decision

**A `StateGraph`, because the useful part is the loop.** plan → select_tools →
act → reflect, with a conditional edge back. A single call cannot look at what a
tool returned and decide to try again; that is the whole reason to reach for
LangGraph rather than the simpler template.

**Tools come from the platform's MCP servers, not from local reimplementations.**
The platform runs eight of them and KAgent's declarative agents already consume
them. Reimplementing `get_service_metrics` here would create a second version to
keep correct.

**Bounded on purpose.** `AGENT_MAX_ITERATIONS` and `recursion_limit` are set
because a small model that keeps deciding "not good enough" will otherwise run
until something else kills it. That is the common case on a 1.5B model, not the
rare one.

**Raw OpenTelemetry, not the Langfuse SDK** — inherited from `telemetry.py` and
load-bearing here. The MCP servers already emit spans for their tool calls; this
service propagates the W3C `traceparent` on every MCP call so those spans nest
under the graph node that made them. Using the Langfuse SDK instead would break
that nesting and a single run would appear as several unrelated traces.

## Consequences

- Anthropic is the default backend so the golden path works before anybody tunes
  a small model. `MODEL_BACKEND=ollama` needs no image rebuild — the binding is
  already installed.
- `MemorySaver` keeps conversation state per process. It survives turns within a
  pod, not a restart or a second replica. Swap it for a persistent checkpointer
  if you need more.
- No MCP servers reachable is a normal state on a core-only cluster, so the agent
  degrades to answering without tools rather than failing the request.
