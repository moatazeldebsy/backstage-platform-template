# IDP Assistant

KAgent AI assistant for the Internal Developer Platform. Helps engineers discover services, check metrics, and scaffold workloads via natural language.

## Capabilities

- **Service discovery** — search the catalog by name, type, or team
- **Metrics lookup** — query Prometheus for service health and DORA metrics
- **Scaffolding** — trigger Backstage templates via the `scaffold_service` tool
- **Deployment status** — list running deployments across namespaces

## Accessing the Assistant

Open [http://backstage.idp.local/ai-assistant](http://backstage.idp.local/ai-assistant) in the Backstage portal.

## Tools

| Tool | Description |
|------|-------------|
| `catalog_search` | Search Backstage catalog entities |
| `get_service_metrics` | Fetch Prometheus metrics for a service |
| `list_templates` | List available Backstage scaffold templates |
| `scaffold_service` | Trigger a Backstage scaffolder template |
| `list_deployments` | List Kubernetes deployments |
| `get_template_params` | Get parameter schema for a template |

## Architecture

The assistant runs as a KAgent `Agent` CRD in the `kagent` namespace. It consumes tools from the `idp-mcp-server` RemoteMCPServer. The Backstage UI talks to it via the proxy at `/api/proxy/kagent`.
