# AI Agent (KAgent)

Scaffold a Kubernetes-native AI agent using KAgent — powered by Anthropic Claude API.
Defines an `Agent` CRD with MCP tool access to the Backstage catalog, Prometheus, and scaffolder.

## What it creates

- An `Agent` CRD in the `kagent` namespace
- MCP tool bindings to the IDP MCP Server (catalog search, scaffold, deployments, metrics)
- A `catalog-info.yaml` registered in the Backstage catalog

## Prerequisites

- Local Kind cluster running with the AI/ML stack (`./scripts/bootstrap-ai.sh`)
- `ANTHROPIC_API_KEY` set in `local/.env`
- KAgent installed in the `kagent` namespace

## Parameters

| Parameter | Description |
|-----------|-------------|
| `name` | Agent name (used as the CRD resource name) |
| `description` | What this agent does |
| `owner` | Backstage owner group |
| `model` | Claude model to use (default: `claude-sonnet-4-5`) |

## After scaffolding

The agent is deployed automatically by the KAgent controller. Access it via the KAgent UI at `http://kagent.idp.local`.
