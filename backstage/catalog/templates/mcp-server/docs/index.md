# MCP Server (kmcp)

Scaffold a Model Context Protocol server managed by the `kmcp` Kubernetes controller.
Defines an `MCPServer` CRD — the controller auto-deploys it as a pod in the `kagent` namespace.

## What it creates

- An `MCPServer` CRD consumed by the kmcp controller
- A TypeScript MCP server skeleton with tool stubs
- A `catalog-info.yaml` registered in the Backstage catalog
- A GitHub Actions CI workflow

## Prerequisites

- Local Kind cluster running with the AI/ML stack (`./scripts/bootstrap-ai.sh`)
- kmcp controller running in the `kagent` namespace

## Parameters

| Parameter | Description |
|-----------|-------------|
| `name` | Server name (used as the CRD resource name and Docker image tag) |
| `description` | What this MCP server exposes |
| `owner` | Backstage owner group |

## After scaffolding

The kmcp controller detects the new `MCPServer` CRD and deploys it automatically.
Register it with a KAgent `Agent` to expose its tools to AI assistants.
