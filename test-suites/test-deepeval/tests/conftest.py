"""
Shared fixtures and the IDP assistant system prompt + tool stubs.

The agent definition lives in kubernetes/kagent/idp-agent.yaml. SYSTEM_PROMPT
below is a verbatim copy of its spec.declarative.systemMessage, and
TOOL_DEFINITIONS mirrors the toolNames it allows.

Do not hand-edit SYSTEM_PROMPT. It is generated, and drift is a CI failure:

    python3 scripts/sync-agent-prompts.py --check-evals   # gate
    python3 scripts/sync-agent-prompts.py --sync-evals    # fix

This matters more than it looks. When the copy drifts, the eval suite grades a
prompt that is not deployed — passing evals then say nothing about the real
agent. That had already happened once: the prompt here was 25 lines while the
deployed agent's was 50, missing session-start memory, the whole QA / contract /
ArgoCD / cost intent-routing section, and the rule forbidding `ask_user`
(a tool call that freezes the chat UI permanently).
"""

import json
import os
import pathlib
import pytest
from deepeval import assert_test as _deepeval_assert_test
from deepeval.models import AnthropicModel

def get_judge_model() -> AnthropicModel:
    return AnthropicModel(model="claude-haiku-4-5-20251001")


JUDGE_MODEL = get_judge_model


# ── Metric capture (for the Langfuse push in CI) ─────────────────────────────
# DeepEval writes a JUnit XML and an HTML report, both of which are per-run
# artifacts — they answer "did this run pass" but not "is the agent getting
# better or worse". Appending each metric here gives scripts/push_to_langfuse.py
# something to turn into a trend line.
#
# Writing the file is unconditional and cheap; pushing it anywhere is opt-in and
# happens later, so a developer running the suite locally is unaffected.

RESULTS_FILE = pathlib.Path(os.environ.get("EVAL_RESULTS_FILE", "results/metrics.jsonl"))


def _current_test_name() -> str:
    # "path::test_name (call)" — pytest sets this for the duration of each test.
    raw = os.environ.get("PYTEST_CURRENT_TEST", "unknown")
    return raw.split("::")[-1].split(" ")[0]


def assert_test(test_case, metrics) -> None:
    """Wrapper around deepeval.assert_test that records each metric's score.

    The tests import this instead of deepeval's version, so no test body has to
    change. Recording happens in a `finally` — a failing metric is exactly the
    one worth having on the trend line, so a raised assertion must not skip it.
    """
    try:
        _deepeval_assert_test(test_case, metrics)
    finally:
        try:
            RESULTS_FILE.parent.mkdir(parents=True, exist_ok=True)
            with RESULTS_FILE.open("a") as fh:
                for m in metrics:
                    fh.write(json.dumps({
                        "test":      _current_test_name(),
                        "metric":    type(m).__name__,
                        "score":     getattr(m, "score", None),
                        "threshold": getattr(m, "threshold", None),
                        "success":   getattr(m, "success", None),
                        "reason":    getattr(m, "reason", None),
                        "input":     getattr(test_case, "input", None),
                        "output":    getattr(test_case, "actual_output", None),
                    }) + "\n")
        except Exception as exc:  # never let telemetry fail a test run
            print(f"[eval] could not record metrics: {exc}")

# Generated from kubernetes/kagent/idp-agent.yaml → spec.declarative.systemMessage
# by scripts/sync-agent-prompts.py --sync-evals. Do not edit by hand.
SYSTEM_PROMPT = """You are the IDP (Internal Developer Platform) assistant for this organization.
You help engineers discover services, check metrics, scaffold new workloads and test suites, manage API contracts, operate ArgoCD releases, track cost/FinOps, and explore available templates.

## Session Start — always do this first
At the start of every new conversation (first message), call `get_user_memory` immediately before responding.
Use the returned preferences to pre-fill defaults: preferredLanguage, defaultTeam, defaultOwner.
Never ask for values you already know from memory.
After a successful scaffold, call `set_user_memory` to record the service name and update scaffoldCount.

## Intent Routing — tools by domain

**Platform / IDP** (scaffold services, check metrics, discover catalog, list deployments):
  catalog_search, catalog_semantic_search, get_service_metrics, list_templates, get_template_params, scaffold_service, list_deployments

**QA / Testing** (test suites, quality metrics):
  list_test_suites, scaffold_test_suite, search_test_catalog, get_test_metrics

**Contract Testing** (API specs, compatibility, breaking changes, Pact generation):
  register_contract, get_contract, list_contracts, generate_contract_tests,
  validate_compatibility, detect_breaking_changes, get_compatibility_report,
  fetch_service_contract, auto_discover_contracts

**Releases / ArgoCD** (application sync, rollback, health, drift):
  list_apps, get_app_health, get_app_diff, sync_app, rollback_app

**Cost / FinOps** (team spend, budgets, rightsizing, forecasting):
  get_team_spend, forecast_budget, list_budget_overruns, get_namespace_cost, get_rightsizing_recommendations

**User Memory** (personalisation across sessions):
  get_user_memory, set_user_memory

## Rules
1. NEVER describe, list, or reference templates from memory. ALWAYS call list_templates first.
2. NEVER call `ask_user`, `adk_request_confirmation`, or any interactive/confirmation tool, under any circumstances. This chat UI cannot render confirmation dialogs — calling this tool freezes the conversation forever with no way for the user to respond. If you need information from the user, your ENTIRE response for this turn must be plain text ending in a question, with NO tool call of any kind in that same turn.
3. If you need information from the user, ask for ALL missing fields in a single plain-text message (per Rule 2). Once the user replies, use those values immediately — NEVER ask "how can I help you with this?" after receiving values you requested.
4. Scaffold flow — execute all steps in the SAME response turn, without pausing for confirmation:
   a. call list_templates → pick the best matching template
   b. call get_template_params → inspect required fields
   c. if any required fields are missing, ask for them ALL in one message
   d. when all required fields are present (from the current or any previous message in this conversation), call scaffold_service IMMEDIATELY
   NEVER ask "Should I proceed?", "Would you like me to scaffold?", "Can you confirm?", or any variation. NEVER respond with "how can I help you with this?" when you already know the user's intent.
5. Context awareness: this is a multi-turn conversation. If you previously asked the user for parameter values (e.g., namespace name, service name, owner, description) and the user's latest message contains those values, USE THEM IMMEDIATELY to call scaffold_service. Do not ask "what would you like to do?" — you already know.
6. The minimum required fields for any service or resource template are: a primary name/identifier, owner. If those are present, scaffold immediately. Map user-provided names directly to the template's primary identifier field (namespace name, service name, component name, etc.).
7. For catalog/metric/deployment/test/contract/release/cost questions: call the relevant tool immediately.
8. Be concise. Show real data from tool results, not assumptions.
9. Transparency before creation — when about to call scaffold_service, state exactly what you are creating in the format: "Creating: [service-name] | Template: [template-ref] | Owner: [owner] | Repo: [repo-name]" — this is the user-visible audit trail. Do this in the SAME message, before the tool call result appears.
10. Dry-run support — if the user says "dry run", "preview", "show me what would be created", or any equivalent, pass `dry_run: true` to scaffold_service and present the preview. Do NOT create the service until the user explicitly proceeds.
11. Rate limit awareness — if you find yourself about to call scaffold_service more than twice in a single session, pause and summarise what you have already created. Do not create the same service name twice.
12. Release operations (sync/rollback): always use dry_run: true first and confirm with the user before the real action.
13. Cost questions: call get_team_spend + forecast_budget together for a complete picture; always show utilization_pct."""


# Tool stubs — mirror the toolNames allowed in idp-agent.yaml.
#
# Kept in step with the CRD's tool allowlist for the same reason SYSTEM_PROMPT
# is: the prompt's intent-routing section names these tools explicitly, so a
# missing definition changes the model's behaviour under eval. The agent is
# allowed 32 tools across five MCP servers; all of them are defined here.
#
# In CI the MCP servers are not reachable, so these return realistic fixture
# data and let Claude produce a complete response for the judge to grade.
#
# Schemas are intentionally minimal — the evals grade whether the agent routes
# to the right tool and uses the result, not whether it fills every optional
# argument.


def _tool(name: str, description: str, required: list[str] | None = None, **props):
    """Build an Anthropic tool definition without repeating the boilerplate."""
    return {
        "name": name,
        "description": description,
        "input_schema": {
            "type": "object",
            "properties": {k: {"type": v} for k, v in props.items()},
            **({"required": required} if required else {}),
        },
    }


TOOL_DEFINITIONS = [
    # ── Platform / IDP (idp-mcp-server) ──────────────────────────────────────
    _tool("catalog_search",
          "Search the Backstage service catalog for components, APIs, and resources.",
          ["query"], query="string"),
    _tool("catalog_semantic_search",
          "Semantic (embedding-based) search over the Backstage catalog.",
          ["query"], query="string"),
    _tool("get_service_metrics",
          "Query Prometheus metrics (request rate, error rate, latency) for a service.",
          ["service_name"], service_name="string"),
    _tool("list_templates",
          "List all available Backstage scaffolder templates."),
    _tool("get_template_params",
          "Fetch the exact parameter schema for a template.",
          ["template_name"], template_name="string"),
    _tool("scaffold_service",
          "Create a new service or resource from a Backstage template. "
          "Pass dry_run=true to preview without creating.",
          ["template_name", "parameters"],
          template_name="string", parameters="object", dry_run="boolean"),
    _tool("list_deployments",
          "List running Kubernetes deployments and their readiness status."),
    _tool("get_user_memory",
          "Fetch the caller's stored preferences (preferredLanguage, defaultTeam, "
          "defaultOwner, scaffoldCount). Call at the start of every conversation."),
    _tool("set_user_memory",
          "Persist user preferences across sessions.",
          ["preferences"], preferences="object"),

    # ── QA / Testing (qa-mcp-server) ─────────────────────────────────────────
    _tool("list_test_suites", "List registered test suites and their tiers."),
    _tool("scaffold_test_suite",
          "Create a new test suite from a QA template.",
          ["template_name", "parameters"],
          template_name="string", parameters="object"),
    _tool("search_test_catalog",
          "Search the test catalog.", ["query"], query="string"),
    _tool("get_test_metrics",
          "Coverage, pass rate and flake rate for a service.",
          ["service_name"], service_name="string"),

    # ── Contract testing (contract-mcp-server) ───────────────────────────────
    _tool("register_contract", "Register an API contract (OpenAPI/AsyncAPI).",
          ["service_name", "spec"], service_name="string", spec="object"),
    _tool("get_contract", "Fetch a registered contract.",
          ["service_name"], service_name="string"),
    _tool("list_contracts", "List all registered API contracts."),
    _tool("generate_contract_tests", "Generate Pact tests from a contract.",
          ["service_name"], service_name="string"),
    _tool("validate_compatibility", "Check a candidate spec against the registered one.",
          ["service_name"], service_name="string", candidate_spec="object"),
    _tool("detect_breaking_changes", "List breaking changes between two spec versions.",
          ["service_name"], service_name="string"),
    _tool("get_compatibility_report", "Full compatibility report for a service.",
          ["service_name"], service_name="string"),
    _tool("fetch_service_contract", "Fetch a contract straight from a running service.",
          ["service_name"], service_name="string"),
    _tool("auto_discover_contracts", "Discover contracts across catalog services."),

    # ── Releases / ArgoCD (argocd-mcp-server) ────────────────────────────────
    _tool("list_apps", "List ArgoCD applications with sync and health status."),
    _tool("get_app_health", "Health status for one ArgoCD application.",
          ["app_name"], app_name="string"),
    _tool("get_app_diff", "Diff live cluster state against desired Git state.",
          ["app_name"], app_name="string"),
    _tool("sync_app", "Sync an ArgoCD application. Use dry_run=true first.",
          ["app_name"], app_name="string", dry_run="boolean"),
    _tool("rollback_app", "Roll an application back to a previous revision. "
          "Use dry_run=true first.",
          ["app_name"], app_name="string", revision="string", dry_run="boolean"),

    # ── Cost / FinOps (cost-mcp-server) ──────────────────────────────────────
    _tool("get_team_spend", "Current and month-to-date spend for a team.",
          ["team"], team="string"),
    _tool("forecast_budget", "Forecast month-end spend against budget.",
          ["team"], team="string"),
    _tool("list_budget_overruns", "Teams currently over budget."),
    _tool("get_namespace_cost", "Cost breakdown for a Kubernetes namespace.",
          ["namespace"], namespace="string"),
    _tool("get_rightsizing_recommendations",
          "CPU/memory rightsizing recommendations and potential savings.",
          ["service_name"], service_name="string"),
]

# Stub responses returned to Claude when it calls a tool during eval.
# Every tool in TOOL_DEFINITIONS has an entry; test_idp_assistant.py falls back
# to an {"error": "unknown tool"} stub if one is ever missing.
TOOL_STUB_RESPONSES: dict[str, str] = {
    # ── Platform / IDP ───────────────────────────────────────────────────────
    "catalog_search": json.dumps({
        "components": [
            {"name": "hello-service", "type": "service", "lifecycle": "production",
             "description": "Go reference service", "owner": "platform-team"},
            {"name": "idp-assistant", "type": "service", "lifecycle": "production",
             "description": "IDP AI assistant (A2A)", "owner": "platform-team"},
        ]
    }),
    "catalog_semantic_search": json.dumps({
        "results": [
            {"name": "payments-api", "score": 0.91,
             "description": "Handles payment intents and refunds", "owner": "payments-team"},
            {"name": "hello-service", "score": 0.44,
             "description": "Go reference service", "owner": "platform-team"},
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
    # Rule 1 of the prompt tells the agent to call this first on every new
    # conversation, so it is hit by essentially every eval case.
    "get_user_memory": json.dumps({
        "preferredLanguage": "go",
        "defaultTeam": "platform-team",
        "defaultOwner": "platform-team",
        "scaffoldCount": 3,
    }),
    "set_user_memory": json.dumps({"status": "success", "updated": True}),

    # ── QA / Testing ─────────────────────────────────────────────────────────
    "list_test_suites": json.dumps({
        "suites": [
            {"name": "test-playwright-e2e", "type": "e2e", "tier": "gold", "owner": "qa-team"},
            {"name": "test-k6-load", "type": "load", "tier": "silver", "owner": "platform-team"},
        ]
    }),
    "scaffold_test_suite": json.dumps({
        "status": "success",
        "pullRequestUrl": "https://github.com/example-org/my-test-suite/pull/1",
    }),
    "search_test_catalog": json.dumps({
        "results": [{"name": "test-playwright-e2e", "service": "hello-service", "tier": "gold"}]
    }),
    "get_test_metrics": json.dumps({
        "coverage_pct": 82.4, "pass_rate_pct": 97.1, "flake_rate_pct": 1.3, "tier": "silver",
    }),

    # ── Contract testing ─────────────────────────────────────────────────────
    "register_contract": json.dumps({"status": "success", "version": "1.4.0"}),
    "get_contract": json.dumps({
        "service": "payments-api", "version": "1.4.0", "format": "openapi-3.1",
        "endpoints": 12,
    }),
    "list_contracts": json.dumps({
        "contracts": [
            {"service": "payments-api", "version": "1.4.0", "format": "openapi-3.1"},
            {"service": "hello-service", "version": "1.0.0", "format": "openapi-3.1"},
        ]
    }),
    "generate_contract_tests": json.dumps({
        "status": "success", "testsGenerated": 12, "framework": "pact",
    }),
    "validate_compatibility": json.dumps({
        "compatible": False, "breakingChanges": 1,
        "summary": "Removed required response field 'refundId' from POST /refunds",
    }),
    "detect_breaking_changes": json.dumps({
        "breakingChanges": [
            {"path": "POST /refunds", "type": "response-field-removed", "field": "refundId",
             "severity": "high"},
        ]
    }),
    "get_compatibility_report": json.dumps({
        "service": "payments-api", "compatible": False,
        "consumersAffected": ["checkout-web", "billing-worker"],
    }),
    "fetch_service_contract": json.dumps({
        "service": "payments-api", "version": "1.4.0", "source": "live /openapi.json",
    }),
    "auto_discover_contracts": json.dumps({
        "discovered": [{"service": "payments-api", "endpoint": "/openapi.json"}]
    }),

    # ── Releases / ArgoCD ────────────────────────────────────────────────────
    "list_apps": json.dumps({
        "apps": [
            {"name": "hello-service", "sync": "Synced", "health": "Healthy", "revision": "9f2c1ab"},
            {"name": "payments-api", "sync": "OutOfSync", "health": "Degraded", "revision": "4b7de02"},
        ]
    }),
    "get_app_health": json.dumps({
        "name": "payments-api", "health": "Degraded", "sync": "OutOfSync",
        "message": "1/3 replicas available — CrashLoopBackOff",
    }),
    "get_app_diff": json.dumps({
        "name": "payments-api",
        "diff": "- image: payments-api:1.3.9\n+ image: payments-api:1.4.0",
    }),
    "sync_app": json.dumps({
        "status": "success", "dryRun": True, "wouldSync": ["Deployment/payments-api"],
    }),
    "rollback_app": json.dumps({
        "status": "success", "dryRun": True, "targetRevision": "9f2c1ab",
    }),

    # ── Cost / FinOps ────────────────────────────────────────────────────────
    "get_team_spend": json.dumps({
        "team": "platform-team", "month_to_date_usd": 1842.55,
        "budget_usd": 2500.00, "utilization_pct": 73.7,
    }),
    "forecast_budget": json.dumps({
        "team": "platform-team", "forecast_month_end_usd": 2410.20,
        "budget_usd": 2500.00, "utilization_pct": 96.4, "will_exceed": False,
    }),
    "list_budget_overruns": json.dumps({
        "overruns": [
            {"team": "data-team", "spend_usd": 3120.00, "budget_usd": 2000.00,
             "utilization_pct": 156.0},
        ]
    }),
    "get_namespace_cost": json.dumps({
        "namespace": "services-dev", "month_to_date_usd": 412.80,
        "top_workloads": [{"name": "idp-mcp-server", "usd": 88.10}],
    }),
    "get_rightsizing_recommendations": json.dumps({
        "service": "hello-service",
        "recommendations": [
            {"resource": "cpu", "current": "500m", "recommended": "150m",
             "monthly_savings_usd": 18.40},
        ],
        "total_monthly_savings_usd": 18.40,
    }),
}
