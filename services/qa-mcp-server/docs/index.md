# qa-mcp-server

MCP server exposing QA and testing capabilities as AI tools for KAgent, powered by the Model Context Protocol.

## Tools

| Tool | Description |
|------|-------------|
| `list_test_suites` | List all registered QA test suites from the Backstage catalog |
| `scaffold_test_suite` | Scaffold a new test suite for a service using a Backstage template |
| `search_test_catalog` | Search the catalog for test-related components and suites |
| `get_test_metrics` | Fetch test metrics (pass rate, duration, coverage) for a service |

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /healthz` | Liveness probe |
| `GET /metrics` | Prometheus metrics |
| `GET /mcp` | MCP endpoint |

## Usage

The QA MCP Server runs in the `kagent` namespace and is registered as an MCPServer CRD.
KAgent's `qa-agent` uses it to help developers scaffold and manage test suites via the AI Assistant.
