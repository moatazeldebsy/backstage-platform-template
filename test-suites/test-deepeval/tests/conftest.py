"""
Shared fixtures and the IDP assistant system prompt + tool stubs.

The agent definition lives in kubernetes/kagent/idp-agent.yaml. Changes to
that file should be reflected here (system prompt and tool list) to keep evals
aligned with what is actually deployed.
"""

import json
import pytest

# Verbatim from kubernetes/kagent/idp-agent.yaml → spec.declarative.systemMessage
SYSTEM_PROMPT = """You are the IDP (Internal Developer Platform) assistant for this organization.
You help engineers discover services, check metrics, scaffold new workloads, and explore available templates.

## Tools — call them; never guess their results
- catalog_search: Search the Backstage service catalog for components, APIs, and resources
- get_service_metrics: Query Prometheus metrics (request rate, error rate, latency) for any service
- list_templates: List all available Backstage scaffolder templates — ALWAYS call this before mentioning any template names
- get_template_params: Fetch the exact parameter schema for a template — ALWAYS call this before scaffold_service
- scaffold_service: Create a new service or resource from a Backstage template
- list_deployments: List running Kubernetes deployments and their readiness status

## Rules
1. NEVER describe, list, or reference templates from memory. ALWAYS call list_templates first.
2. NEVER use the ask_user tool or any interactive confirmation tool. This chat does not support form dialogs.
3. If you need information from the user, ask for ALL missing fields in a single message. Once the user replies, use those values immediately — NEVER ask "how can I help you with this?" after receiving values you requested.
4. Scaffold flow — execute all steps in the SAME response turn, without pausing for confirmation:
   a. call list_templates → pick the best matching template
   b. call get_template_params → inspect required fields
   c. if any required fields are missing, ask for them ALL in one message
   d. when all required fields are present (from the current or any previous message in this conversation), call scaffold_service IMMEDIATELY
   NEVER ask "Should I proceed?", "Would you like me to scaffold?", "Can you confirm?", or any variation. NEVER respond with "how can I help you with this?" when you already know the user's intent.
5. Context awareness: this is a multi-turn conversation. If you previously asked the user for parameter values (e.g., namespace name, service name, owner, description) and the user's latest message contains those values, USE THEM IMMEDIATELY to call scaffold_service. Do not ask "what would you like to do?" — you already know.
6. The minimum required fields for any service or resource template are: a primary name/identifier, owner. If those are present, scaffold immediately. Map user-provided names directly to the template's primary identifier field (namespace name, service name, component name, etc.).
7. For catalog/metric/deployment questions: call the relevant tool immediately.
8. Be concise. Show real data from tool results, not assumptions."""

# Tool stubs — mirror the MCP tools registered in idp-agent.yaml.
# In CI the MCP server is not reachable; these stubs return realistic fixture
# data so Claude can produce a complete response for evaluation.
TOOL_DEFINITIONS = [
    {
        "name": "catalog_search",
        "description": "Search the Backstage service catalog for components, APIs, and resources.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query"}
            },
            "required": ["query"],
        },
    },
    {
        "name": "get_service_metrics",
        "description": "Query Prometheus metrics (request rate, error rate, latency) for a service.",
        "input_schema": {
            "type": "object",
            "properties": {
                "service_name": {"type": "string", "description": "Name of the service"}
            },
            "required": ["service_name"],
        },
    },
    {
        "name": "list_templates",
        "description": "List all available Backstage scaffolder templates.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "get_template_params",
        "description": "Fetch the exact parameter schema for a template.",
        "input_schema": {
            "type": "object",
            "properties": {
                "template_name": {"type": "string", "description": "Template name"}
            },
            "required": ["template_name"],
        },
    },
    {
        "name": "scaffold_service",
        "description": "Create a new service or resource from a Backstage template.",
        "input_schema": {
            "type": "object",
            "properties": {
                "template_name": {"type": "string"},
                "parameters": {"type": "object"},
            },
            "required": ["template_name", "parameters"],
        },
    },
    {
        "name": "list_deployments",
        "description": "List running Kubernetes deployments and their readiness status.",
        "input_schema": {"type": "object", "properties": {}},
    },
]

# Stub responses returned to Claude when it calls a tool during eval
TOOL_STUB_RESPONSES: dict[str, str] = {
    "catalog_search": json.dumps({
        "components": [
            {"name": "hello-service", "type": "service", "lifecycle": "production",
             "description": "Go reference service", "owner": "platform-team"},
            {"name": "idp-assistant", "type": "service", "lifecycle": "production",
             "description": "IDP AI assistant (A2A)", "owner": "platform-team"},
        ]
    }),
    "get_service_metrics": json.dumps({
        "request_rate": "42.3 req/s",
        "error_rate": "0.12%",
        "p99_latency_ms": 87,
    }),
    "list_templates": json.dumps({
        "templates": [
            {"name": "nodejs-service", "description": "Scaffold a Node.js microservice"},
            {"name": "python-service", "description": "Scaffold a Python microservice"},
            {"name": "go-service", "description": "Scaffold a Go microservice"},
            {"name": "mlflow-experiment", "description": "Scaffold an MLflow training job"},
        ]
    }),
    "get_template_params": json.dumps({
        "required": ["serviceName", "owner"],
        "properties": {
            "serviceName": {"type": "string", "description": "Name of the new service"},
            "owner": {"type": "string", "description": "Owning team"},
            "description": {"type": "string", "description": "Short description"},
        },
    }),
    "scaffold_service": json.dumps({
        "status": "success",
        "message": "Service scaffolded successfully",
        "pullRequestUrl": "https://github.com/example-org/my-new-service/pull/1",
    }),
    "list_deployments": json.dumps({
        "deployments": [
            {"name": "hello-service", "namespace": "services", "ready": "2/2", "upToDate": 2},
            {"name": "idp-mcp-server", "namespace": "services-dev", "ready": "1/1", "upToDate": 1},
        ]
    }),
}
