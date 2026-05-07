# ADR-0001: Initial agent decisions

- **Status:** Accepted
- **Date:** ${{ values.date | default("TBD") }}

## Context

`${{ values.name }}` was scaffolded through the IDP self-service portal using the
AI Agent (KAgent) golden path.

## Decisions

### 1. Runtime — KAgent on Kind/EKS

Use the KAgent operator (Agent CRD) rather than a bespoke Python/Node LangChain
service. KAgent manages lifecycle, retries, and tool routing declaratively.

### 2. Model — ${{ values.model }} via Anthropic Claude API

Anthropic Claude is used for all environments (local Kind and AWS EKS).
The API key is stored in the `kagent-anthropic` Kubernetes Secret and
referenced by the `claude-anthropic` ModelConfig CRD.

Changing the model later requires only patching the ModelConfig or editing
`kubernetes/agent.yaml` and re-applying — no image rebuild needed.

Available models: `claude-haiku-4-5-20251001` (fast), `claude-sonnet-4-6` (balanced), `claude-opus-4-7` (most capable).

### 3. Tools — MCP over IDP MCP Server

All tools (`catalog_search`, `get_service_metrics`, `scaffold_service`) are
exposed through the shared `idp-mcp-server` RemoteMCPServer rather than
embedding tool logic in the agent spec. This keeps the agent spec stable while
tool capabilities evolve independently.

## Consequences

- No bespoke container image to maintain for this agent.
- Model upgrades are a one-line YAML change.
- Tool changes require only a new release of `idp-mcp-server` — no agent re-scaffold.
- Future architectural deviations must be recorded as follow-up ADRs.
