# idp-mcp-server

MCP server exposing IDP capabilities as AI tools for KAgent, powered by the Model Context Protocol.

## Tools

| Tool | Description |
|------|-------------|
| `catalog_search` | Search the Backstage catalog for services, templates, and components |
| `get_service_metrics` | Fetch Prometheus metrics for a deployed service |
| `get_template_params` | Retrieve parameters for a Backstage scaffolder template |
| `scaffold_service` | Trigger a Backstage scaffolder template to create a new service |
| `list_deployments` | List running deployments in the Kind/EKS cluster |
| `list_templates` | List all available Backstage software templates |

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /healthz` | Liveness probe |
| `GET /metrics` | Prometheus metrics |
| `GET /sse` | MCP SSE transport endpoint |

## Usage

The IDP MCP Server runs in the `kagent` namespace and is registered as an MCPServer CRD.
KAgent's `idp-assistant` agent uses it to handle developer requests from the Backstage AI Assistant page.
