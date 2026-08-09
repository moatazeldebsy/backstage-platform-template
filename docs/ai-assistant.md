# AI Assistant

The AI Assistant is a chat interface embedded in the Backstage portal backed by
[KAgent](https://kagent.dev) AI agents (Claude) with live access to the service
catalog, Prometheus metrics, Kubernetes deployments, Backstage scaffolder, test
suites, contract testing, GitHub PRs, cost/budget data, ArgoCD application state,
and persistent user memory. This is the foundation the
[Agentic Development Platform (ADP)](agentic-platform.md) epic builds on.

---

## Architecture

The AI Assistant is a **native React chat component** embedded directly in the Backstage frontend. It is not an iframe.

```
┌──────────────────────────────────────────────────────────────────┐
│  Backstage (Docker Compose / EKS pod)                            │
│                                                                  │
│  extensions.tsx — AiAssistantPage                                │
│    POST /api/proxy/kagent/a2a/kagent/platform-assistant          │
│    GET  /api/proxy/kagent/api/sessions/<id>  (poll)              │
│    X-Backstage-User: <userRef>  header on every request          │
└───────────────────────┬──────────────────────────────────────────┘
                        │  Backstage proxy
                        ▼
┌──────────────────────────────────────────────────────────────────┐
│  KAgent  (namespace: kagent)                                     │
│  kagent-ui.kagent.svc.cluster.local:8080  (in-cluster)           │
│  http://kagent.idp.local  (local ingress)                        │
│                                                                  │
│  Agents:                                                         │
│    platform-assistant  — unified entry point (claude-sonnet)     │
│    idp-assistant       — platform / scaffolding (claude-haiku)   │
│    qa-assistant        — test suites + PR review (claude-sonnet) │
│    contract-assistant  — API contracts (claude-sonnet)           │
│    cost-agent          — cost/budget analysis (claude-sonnet)    │
│    release-agent       — ArgoCD sync/rollback (claude-sonnet)    │
│    incident-agent      — alert triage (claude-sonnet)            │
└──────┬──────────┬──────────────┬────────────┬───────┬───────┬───────┬────┘
       │ MCP/HTTP │              │            │       │       │       │
       ▼          ▼              ▼            ▼       ▼       ▼       ▼
 ┌──────────┐┌──────────┐┌──────────────┐┌──────────┐┌────────┐┌──────────┐┌───────────┐
 │ idp-mcp  ││ qa-mcp   ││ contract-mcp ││ github-mcp││cost-mcp││argocd-mcp││incident-mcp│
 │ :3001    ││ :3002    ││ :3003        ││ :3005     ││ :3007  ││ :3006    ││ :3008      │
 │ 9 tools  ││ 4 tools  ││ 9 tools      ││ 5 tools   ││5 tools ││5 tools   ││5 tools     │
 └──────────┘└──────────┘└──────────────┘└──────────┘└────────┘└──────────┘└───────────┘

Event Bus (agent-event-router :3004)
  ← GitHub webhooks (PR open/update → qa-assistant)
  ← AlertManager webhooks (budget alerts → cost-agent; critical non-budget alerts → incident-agent
                            (+ opens/resolves a GitHub incident issue); other firing alerts → idp-assistant)
  ← ArgoCD webhooks (OutOfSync/Degraded → release-agent)
```

### CLI

```bash
idp ai "scaffold a Go payment service for team-platform"
# Calls platform-assistant via A2A, streams response to terminal
```

---

## Component breakdown

### 1. Backstage frontend — `AiAssistantPage`

**File:** `backstage/app/packages/app/src/extensions.tsx`

Registered as a Backstage frontend plugin extension at route `/ai-assistant` with a
nav item (chat icon) in the sidebar. The component is registered via `createFrontendPlugin`
in `extensions.tsx` using Backstage's new declarative plugin API (`@backstage/frontend-plugin-api` v0.15+).

**Quick-action chips:** On an empty chat, 6 clickable suggestion chips appear (e.g.
"Scaffold a Go service", "List deployments", "Find payment services"). Clicking one
pre-fills the input — the user still hits Enter to send.

**User identity:** On every request the frontend sets `X-Backstage-User: <userRef>`
(e.g. `user:default/moataz.nabil`) as an HTTP header. This header is forwarded to
the `platform-assistant` A2A call and propagated to every MCP tool call. The MCP
server binds the user's memory key at the HTTP boundary — the LLM never receives or
controls this value, preventing cross-user IDOR.

**Message flow per user turn:**

```
1. Generate a UUID contextId (used to locate the session after creation)
2. POST /api/proxy/kagent/a2a/kagent/platform-assistant  { jsonrpc: "2.0", method: "message/send", … }
   headers: { X-Backstage-User: <userRef> }
   — fire and ignore the SSE response (KAgent streams SSE, not JSON)
3. Poll GET /api/proxy/kagent/api/sessions  every 500 ms for up to 12 s
   — find the session whose id matches contextId (or the most-recent platform_assistant session)
4. Poll GET /api/proxy/kagent/api/sessions/<sessionId>  every 1 s for up to 90 s
   — inspect the last agent event:
       function_call present  → tool round-trip in progress, keep polling
       function_response      → agent generating next text, keep polling
       plain text only        → turn complete, render the message
5. Concatenate all non-partial agent text parts and display as the assistant bubble
```

**`ask_user` / interactive form fallback:**
KAgent may emit an `ask_user` function call when it wants to render a form dialog.
The Backstage chat UI cannot render ADK form widgets, so the frontend detects this
event, extracts the question text from the function call args, and appends them as
plain text. The system message Rule 2 now explicitly forbids the agent from calling
this tool.

**New Chat button:** clears local `messages` state only — the KAgent session on the
server is not deleted. Each new message creates a fresh contextId, so the next
user turn starts a new server-side session.

---

### 2. Backstage proxy config

**Base config (`backstage/app-config.yaml`):**
```yaml
proxy:
  endpoints:
    /kagent:
      target: http://kagent-ui.kagent.svc.cluster.local:8080
      allowedMethods: ['GET', 'POST']
      changeOrigin: true
```

**Local override (`backstage/app-config.local.yaml`):**
```yaml
proxy:
  endpoints:
    /kagent:
      target: http://kagent.idp.local
      allowedMethods: ['GET', 'POST']
      changeOrigin: true
```

The local override is needed because `kagent-ui.kagent.svc.cluster.local` is not
resolvable from the Backstage Docker Compose container (it runs on the host network,
not inside the Kind cluster). The `/etc/hosts` entry for `kagent.idp.local` pointing
to `127.0.0.1` is sufficient.

---

### 3. KAgent agents

#### `platform-assistant` — unified entry point

**File:** `kubernetes/kagent/platform-agent.yaml`  
**Model:** `claude-sonnet` (claude-sonnet-4-6)

The primary agent exposed in the Backstage chat UI and the `idp ai` CLI. Holds all
22 tools from all four MCP servers and routes by intent. On every new session it
calls `get_user_memory` to load the user's preferences (language, team, owner) before
responding, so defaults are pre-filled without asking.

| Domain | Tools |
|--------|-------|
| Platform / IDP | `catalog_search`, `catalog_semantic_search`, `get_service_metrics`, `list_templates`, `get_template_params`, `scaffold_service`, `list_deployments` |
| User memory | `get_user_memory`, `set_user_memory` |
| QA / testing | `list_test_suites`, `scaffold_test_suite`, `search_test_catalog`, `get_test_metrics` |
| Contract testing | `register_contract`, `get_contract`, `list_contracts`, `generate_contract_tests`, `validate_compatibility`, `detect_breaking_changes`, `get_compatibility_report`, `fetch_service_contract`, `auto_discover_contracts` |

**System message rules (summarised):**

| Rule | Behaviour |
|------|-----------|
| 1 | Never reference templates from memory — always call `list_templates` first |
| 2 | Never call `ask_user` or any interactive confirmation tool |
| 3 | Ask for missing info as plain text; ask for ALL fields in one message |
| 4 | Scaffold flow: `list_templates` → `get_template_params` → `scaffold_service` — **immediately, no confirmation prompt** |
| 5 | Minimum required fields: `name`, `owner` — scaffold immediately when both are present |
| 6 | Session start: call `get_user_memory` before responding; use stored preferences |
| 7 | After scaffold: call `set_user_memory` to record service and update count |
| 8 | Be concise; show real tool results, not assumptions |

#### Specialist agents

| Agent | File | Model | Purpose |
|-------|------|-------|---------|
| `idp-assistant` | `kubernetes/kagent/idp-agent.yaml` | claude-haiku | Platform / scaffolding only |
| `qa-assistant` | `kubernetes/kagent/qa-agent.yaml` | claude-sonnet | Test suites + GitHub PR review |
| `contract-assistant` | `kubernetes/kagent/contract-agent.yaml` | claude-sonnet | API contracts |
| `cost-agent` | `kubernetes/kagent/cost-agent.yaml` | claude-sonnet | Cost/budget analysis via `cost-mcp-server` + `catalog_search` |
| `release-agent` | `kubernetes/kagent/release-agent.yaml` | claude-sonnet | ArgoCD sync/rollback via `argocd-mcp-server` + `list_deployments` |
| `incident-agent` | `kubernetes/kagent/incident-agent.yaml` | claude-sonnet | Alert triage via `incident-mcp-server` + `get_service_metrics`/`list_deployments` |
| `security-agent` | `kubernetes/kagent/security-agent.yaml` | claude-sonnet | Read-only: vulnerable deps, secret rotation, policy violations via `security-mcp-server` |
| `onboarding-agent` | `kubernetes/kagent/onboarding-agent.yaml` | claude-haiku | Template/catalog/docs discovery — reuses `idp-mcp-server`, no new MCP server |

Specialist agents are still available at `/a2a/kagent/<name>` but `platform-assistant`
is the recommended entry point for all developer interactions.

`cost-agent` and `release-agent` are also **proactive** — the event router (§5) invokes
them directly on budget alerts and ArgoCD degraded-state webhooks, without a human
starting the conversation. `release-agent`'s system prompt requires `dry_run: true` on
`sync_app`/`rollback_app` before any real action, and an explicit user confirmation
("go ahead" / "proceed" / "confirm") before dropping dry-run — the only HiTL-style
convention in the platform today (see [agentic-platform.md](agentic-platform.md) Phase 4
for the plan to formalize this into a real approval gate).

#### ModelConfigs

| Name | Model | Use |
|------|-------|-----|
| `claude-anthropic` | claude-haiku-4-5-20251001 | Fast, cheap — `idp-assistant` |
| `claude-sonnet` | claude-sonnet-4-6 | Balanced — `platform-assistant`, `qa-assistant`, `contract-assistant` |
| `claude-opus` | claude-opus-4-8 | Highest quality — available for future agents |
| `openai-prod` | gpt-4o | Optional; set `OPENAI_API_KEY` to enable |

---

### 4. MCP Servers

All MCP servers use the `@modelcontextprotocol/sdk` Streamable HTTP transport. Because
`McpServer.connect()` can only be called once per instance, a fresh `McpServer` is
created per request (`createServer()` factory).

#### `idp-mcp-server` (port 3001)

**File:** `services/idp-mcp-server/src/index.ts`

| Tool | Upstream | Notes |
|------|----------|-------|
| `catalog_search` | Backstage `/api/catalog/entities` | Exact-match first, falls back to fuzzy filter |
| `catalog_semantic_search` | Backstage `/api/rag-search/search` | Natural-language vector search via Voyage AI + pgvector |
| `get_service_metrics` | Prometheus `/api/v1/query` | Defaults to `http_requests_total` |
| `list_templates` | Backstage catalog (kind=Template) | Returns name, title, description, templateRef |
| `get_template_params` | Backstage catalog entity by name | Returns full parameter schema for a template |
| `scaffold_service` | Backstage scaffolder v2 tasks API | Auto-builds repoUrl; polls for up to 3 min; supports `dry_run: true` |
| `list_deployments` | Kubernetes apps/v1 Deployments | Defaults to namespace `services` |
| `get_user_memory` | Kubernetes ConfigMap in `kagent` ns | Reads `user-memory-<userRef>` preferences JSON |
| `set_user_memory` | Kubernetes ConfigMap in `kagent` ns | Patch-merges key/value into preferences JSON |

**User memory RBAC:** `idp-mcp-server` has a `Role` in the `kagent` namespace granting
`configmaps` get/create/update, bound to the `services-dev/idp-mcp-server` service
account. See `kubernetes/kagent/idp-mcp-server-rbac.yaml`.

**Environment variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `BACKSTAGE_URL` | `http://host.docker.internal:3000` | Internal Backstage URL |
| `BACKSTAGE_EXTERNAL_URL` | `http://backstage.idp.local` | Browser-accessible URL (used in task output links) |
| `BACKSTAGE_TOKEN` | *(empty)* | Static token from `app-config.local.yaml` |
| `PROMETHEUS_URL` | `http://prometheus-kube-prometheus-prometheus.monitoring:9090` | In-cluster Prometheus |
| `K8S_API` | `https://kubernetes.default.svc` | In-cluster Kubernetes API |
| `PORT` | `3001` | HTTP listen port |

#### `qa-mcp-server` (port 3002)

4 tools: `list_test_suites`, `scaffold_test_suite`, `search_test_catalog`, `get_test_metrics`. See `services/qa-mcp-server/`.

#### `contract-mcp-server` (port 3003)

9 tools for self-describing, self-testing APIs. See `docs/contract-testing.md`.

#### `github-mcp-server` (port 3005)

**File:** `services/github-mcp-server/src/index.ts`

| Tool | GitHub API call | Notes |
|------|----------------|-------|
| `get_pr_diff` | `GET /repos/{repo}/pulls/{pr}/files` | Returns changed files with additions/deletions |
| `add_pr_comment` | `POST /repos/{repo}/issues/{pr}/comments` | Posts a markdown comment; emits `[AUDIT]` log |
| `get_ci_status` | PR head SHA → `GET /repos/{repo}/commits/{sha}/check-runs` | Returns all check-run results |
| `approve_pr` | `POST /repos/{repo}/pulls/{pr}/reviews` (`event: APPROVE`) | Defaults to `dry_run: true` — no HiTL approval gate exists yet (Phase 4) |
| `request_changes` | `POST /repos/{repo}/pulls/{pr}/reviews` (`event: REQUEST_CHANGES`) | Defaults to `dry_run: true`; `body` required |

**Secret:** `github-mcp-server-token` in `services-dev` namespace, key `token`.
Optional locally (warns on startup if missing), required in AWS.

**Used by:** `qa-assistant` for automated PR review; `platform-assistant` for cross-domain queries.

#### `argocd-mcp-server` (port 3006)

**File:** `services/argocd-mcp-server/src/server.ts` (tools), `services/argocd-mcp-server/src/index.ts` (entrypoint)

| Tool | ArgoCD API call | Notes |
|------|-----------------|-------|
| `list_apps` | `GET /api/v1/applications` | Lists all ArgoCD-managed apps |
| `get_app_health` | `GET /api/v1/applications/{name}` | Returns sync + health status |
| `get_app_diff` | `GET /api/v1/applications/{name}/managed-resources` | Live vs. desired state diff |
| `sync_app` | `POST /api/v1/applications/{name}/sync` | Supports `dry_run: true` (default); `[AUDIT]` log on real sync |
| `rollback_app` | `POST /api/v1/applications/{name}/rollback` | Supports `dry_run: true` (default); `[AUDIT]` log on real rollback |

**Secret:** `argocd-mcp-server-token` in `services-dev` namespace. Optional locally (warns and 401s on tool calls if missing), required in AWS.

**Used by:** `release-agent`, proactively triggered on ArgoCD `OutOfSync`/`Degraded` webhooks.

#### `cost-mcp-server` (port 3007)

**File:** `services/cost-mcp-server/src/server.ts` (tools), `services/cost-mcp-server/src/index.ts` (entrypoint)

| Tool | Upstream | Notes |
|------|----------|-------|
| `get_namespace_cost` | OpenCost `/model/allocation` | Per-namespace cost breakdown |
| `get_team_spend` | Prometheus `idp_team_actual_cost_usd_monthly` | Requires tech-insights-exporter |
| `list_budget_overruns` | Prometheus `idp_team_*` metrics | Teams over their configured budget |
| `get_rightsizing_recommendations` | OpenCost `/model/allocation` | Suggests requests/limits adjustments |
| `forecast_budget` | Prometheus (current burn rate) | End-of-month spend projection |

**Used by:** `cost-agent`, proactively triggered on `TeamBudgetWarning`/`TeamBudgetExceeded`/`TeamBudgetOverrun` AlertManager alerts.

#### `incident-mcp-server` (port 3008)

**File:** `services/incident-mcp-server/src/server.ts` (tools), `services/incident-mcp-server/src/index.ts` (entrypoint)

| Tool | Upstream | Notes |
|------|----------|-------|
| `get_open_incidents` | GitHub issues search, `labels=incident:open` | Reads back what `agent-event-router`'s `createIncidentIssue` writes |
| `get_alert_history` | Prometheus `ALERTS` metric, `query_range` | Summarizes firing periods over a configurable window (default 24h, max 168h) |
| `get_runbook` | GitHub contents API, `docs/runbooks/{name}.md` | Falls back to listing available runbooks if the name doesn't match |
| `post_incident_update` | `POST /repos/{repo}/issues/{issue}/comments` | `[AUDIT]` logged |
| `send_notification` | Slack incoming webhook | No-op (`sent: false`) if `SLACK_WEBHOOK_URL` is unset |

**Secrets:** reuses `github-mcp-server-token` for `GITHUB_TOKEN`; `incident-mcp-server-secrets` (key `slack-webhook-url`) for `SLACK_WEBHOOK_URL`, created by `bootstrap-ai.sh --adp` when `SLACK_WEBHOOK_URL` is set in `local/.env`.

**Used by:** `incident-agent`, proactively triggered on critical non-budget AlertManager alerts.

---

### 5. Event Bus — `agent-event-router`

**File:** `services/agent-event-router/src/index.ts` (Express app + webhook auth), `services/agent-event-router/src/router.ts` (routing logic)

A small Express service (port 3004) that receives webhooks from GitHub, AlertManager,
and ArgoCD and fans out to agents via A2A. This is what makes agents **proactive** —
they respond to platform events without a human initiating the conversation.

| Source | Trigger | Target agent | Action |
|--------|---------|--------------|--------|
| GitHub | `pull_request` opened/updated | `qa-assistant` | Review test coverage, post PR comment |
| GitHub | `push` to main | `idp-assistant` | Notify of new deployment candidate |
| AlertManager | `firing` alert, name/labels match budget (`TeamBudgetWarning`/`TeamBudgetExceeded`/`TeamBudgetOverrun` or containing "budget") | `cost-agent` | Call `get_team_spend` + `forecast_budget` + `get_rightsizing_recommendations` for the team |
| AlertManager | `firing` alert, non-budget, `severity: critical` | `incident-agent` | A GitHub incident issue is created first (via `createIncidentIssue`, tracked in-memory by alert fingerprint); the agent message references its issue number. Call `get_alert_history` + `get_runbook`, cross-reference deployments/metrics, post findings via `post_incident_update` |
| AlertManager | `firing` alert, non-budget, any other severity | `idp-assistant` | Diagnose + suggest remediation |
| AlertManager | `resolved` status for a tracked fingerprint | *(none — closes the GitHub issue via `resolveIncidentIssue`)* | Closes the incident issue opened above |
| ArgoCD | App `OutOfSync` or `Degraded` | `release-agent` | Call `get_app_health` + `get_app_diff`, then propose sync or rollback (dry-run first) |

**Security:**
- GitHub webhooks: HMAC-SHA256 signature verified via `crypto.timingSafeEqual` with
  raw body capture. Fails closed (503) if `GITHUB_WEBHOOK_SECRET` is not configured.
- AlertManager / ArgoCD webhooks: `Authorization: Bearer <WEBHOOK_TOKEN>` required.
- All routes respond 200 immediately (fire-and-forget) to avoid webhook timeout.

**Secrets:**
- `agent-event-router-webhook-token` in `services-dev` namespace (key: `token`) — used
  as the bearer token in AlertManager's `http_config.authorization.credentials`.
- `GITHUB_WEBHOOK_SECRET` env var on the deployment.

**Local ingress:** `http://agent-event-router.idp.local`

---

### 6. `idp ai` CLI

**File:** `cli/cmd/idp/ai.go`

```bash
# Ask anything — streams the platform-assistant response to your terminal
idp ai "scaffold a Go payment service for team-platform"
idp ai "what services are owned by team-qa?"
idp ai "show me the error rate for hello-service"

# Override the KAgent URL (defaults to http://kagent.idp.local)
KAGENT_URL=http://my-cluster.example.com idp ai "list deployments"
idp ai --kagent-url http://my-cluster.example.com "list deployments"

# Adjust timeout (default 300s)
idp ai --timeout 60 "quick catalog search"
```

The command posts a JSON-RPC 2.0 A2A message to `platform-assistant`, then polls
`/api/sessions` for a response. Tool status lines are printed to stderr during
processing so you can see what the agent is doing.

---

## Scaffolding flow (step-by-step)

When a user says "scaffold a Python FastAPI service called demo-svc, description demo, owner group:default/qa-team":

```
Agent turn 1 (same response):
  1. call list_templates
     → returns template list including template:default/python-service
  2. call get_template_params { template_ref: "template:default/python-service" }
     → returns { params: [ {key:"name", required:true}, {key:"description",...}, ... ] }
  3. All required fields (name, description, owner) are already known
  4. call scaffold_service {
       template_ref: "template:default/python-service",
       values: { name: "demo-svc", description: "demo", owner: "group:default/qa-team" }
     }
     → MCP server auto-builds repoUrl: "github.com?owner=qa-team&repo=demo-svc"
     → POSTs to Backstage scaffolder, polls until completed/failed (up to 3 min)
     → returns { task_id, status: "completed", ui_url: "http://backstage.idp.local/create/tasks/<id>" }
  5. Agent responds with task result and the Backstage task URL
```

The agent never breaks this into multiple turns or asks for confirmation.

---

## Guardrails & Audit Log

### Structured audit log

Every tool call on `idp-mcp-server`, `contract-mcp-server`, `argocd-mcp-server`,
`github-mcp-server`, and `incident-mcp-server` emits a structured `[AUDIT]` JSON line
to stdout for mutating actions (`scaffold_service`, `register_contract`,
`sync_app`/`rollback_app`, `add_pr_comment`, `approve_pr`/`request_changes`,
`post_incident_update`, `send_notification`). `cost-mcp-server` has no audit log — all
five of its tools are read-only.

```json
[AUDIT] {"ts":"2026-06-09T12:00:00Z","server":"idp-mcp-server","action":"scaffold_service_requested","agent":"platform-assistant","service":"demo-svc","template":"python-service","dry_run":false}
```

| Field | Description |
|-------|-------------|
| `ts` | ISO-8601 timestamp |
| `server` | MCP server name (`idp-mcp-server`, `contract-mcp-server`) |
| `action` | Tool-specific action identifier (e.g. `scaffold_service_requested`, `register_contract_requested`) |
| `agent` | Agent ID extracted from the `X-Agent-ID` header, falling back to `User-Agent` |
| Tool-specific fields | e.g. `service`, `template`, `dry_run`, `provider`, `version` |

**ADP Phase 4 (HiTL approval gate):** `approval-service` (docs/agentic-platform.md)
emits its own `[AUDIT]` lines with `event: "approval_requested"`, `"approval_auto_approved"`,
and `"approval_decided"`, each carrying `approval_id`, `action`, `agent`, `target`, and —
once decided — `decision`/`decided_by`. This is the audit trail for every approval a
human made (or that Policy-as-Prompt auto-approved) — cross-reference the `approval_id`
that appears in the gated tool's own `[AUDIT]` entries (`sync_app_requested`, etc.) once
those tools pass one through.

### Querying audit logs in Loki

```logql
# All audit events from the IDP MCP server
{app="idp-mcp-server"} |= "[AUDIT]" | json

# Scaffold calls only
{app="idp-mcp-server"} |= "[AUDIT]" | json | action="scaffold_service_requested"

# Contract registration events
{app="contract-mcp-server"} |= "[AUDIT]" | json | action="register_contract_requested"
```

### Per-agent attribution metrics

The `mcp_agent_tool_calls_total{server,tool,agent}` Prometheus counter tracks every tool call broken down by MCP server, tool name, and agent ID:

```promql
# Tool call rate per agent
rate(mcp_agent_tool_calls_total{server="idp-mcp-server"}[5m])

# Error rate per tool
rate(mcp_tool_calls_total{outcome="error"}[5m]) /
rate(mcp_tool_calls_total[5m])
```

These metrics are visible in the **AI Platform** Grafana dashboard at `http://grafana.idp.local/d/ai-platform`.

### dry_run mode

Pass `dry_run: true` to `scaffold_service` to get a preview of what would be created without actually creating anything:

```
User: "dry run: scaffold a Go service called test-svc, owner platform-team"
```

The agent detects "dry run", "preview", or "what would happen" phrasing and passes `dry_run: true` to the tool. The tool returns a preview JSON showing the template, values, and computed `repoUrl` without making any Backstage scaffolder calls.

### KAgent system-prompt guardrails

`kubernetes/kagent/idp-agent.yaml` includes guardrail rules that govern agent behaviour:

| Rule | Behaviour |
|------|-----------|
| 9 | Announce to the user before performing any destructive or state-changing operation (scaffold, deploy) |
| 10 | Support `dry_run: true` — use it when the user says "dry run", "preview", or "what would happen if" |
| 11 | If `scaffold_service` has been called more than 3 times in the same session, pause and ask the user to confirm intent before proceeding |

### Agent ID extraction

The MCP server extracts the calling agent's identity from HTTP headers in priority order:

1. `X-Agent-ID` header (set explicitly by KAgent)
2. `User-Agent` header (fallback — includes the KAgent agent name)

This identity is used in both the `[AUDIT]` log entry and the `mcp_agent_tool_calls_total{agent}` label, enabling per-agent attribution in Grafana and Loki.

### Guardrail alerts

Two PrometheusRules in the `kagent-guardrails` group alert on abnormal agent behaviour:

| Alert | Condition | Severity |
|-------|-----------|----------|
| `ScaffoldServiceHighRate` | > 5 scaffold calls in 10 min from any agent | Warning |
| `McpToolErrorRateHigh` | > 50% error rate on any MCP tool | Warning |

Both alerts route to Slack `#platform-alerts`. See the [KAgent Guardrails runbook](runbooks/kagent-guardrails.md).

---

## Where the AI pages come from (and why they're hidden)

The AI pages — **AI Assistant**, **AI Search**, **Agent Approvals**, **KAgent Platform** — are
disabled by default. `bootstrap-local.sh` on its own installs no AI stack, so those pages and
their sidebar nav items would dead-end on a connection error. They are revealed only once the
stack behind them exists.

| Layer | File | AI pages |
|---|---|---|
| Base | `backstage/app-config.yaml` | `disabled: true` for all four, `aiStack.enabled: false` |
| Local overlay (generated) | `local/backstage/app-config.ai.yaml` | Written `false` by `bootstrap-local.sh`, `true` by `bootstrap-ai.sh`, back to `false` by `bootstrap-ai.sh --destroy` |
| AWS | `backstage/app-config.aws.yaml` | Enabled — this layer replaces the extensions array and doesn't re-disable them |

Both scripts call one helper, `write_backstage_ai_overlay` in `scripts/lib.sh`, so the list
can't drift between them.

**Three things to know before touching this:**

1. **Config is read only at startup.** Running `bootstrap-ai.sh` does not make the pages
   appear in a running Backstage — restart it with `./scripts/bootstrap-local.sh --start-backstage`.
2. **Backstage replaces `app.extensions` arrays, it does not merge them.** The generated
   overlay must repeat *every* entry from the earlier layers. Anything you add to
   `app-config.yaml`'s extension list has to be added to `write_backstage_ai_overlay` too,
   or the overlay silently drops it.
3. **The `page:kubernetes: disabled` entry in that generated list is not AI-related and not
   optional.** The standalone Kubernetes route renders the entity Kubernetes tab outside any
   entity context and dies with "Entity context is not available". Because of rule 2, dropping
   it from the overlay brings that crash back.

`aiStack.enabled` is a separate flag for the same state: it drives the hardcoded AI links on
the custom Home / Support / Learning Center pages, which `app.extensions` can't reach. The
same helper keeps the two in step.

The file is gitignored and generated — hand edits are lost on the next bootstrap run.

---

## Troubleshooting

### An AI page is missing from the sidebar

The AI overlay is off, or Backstage hasn't restarted since it was turned on.

```bash
grep -A1 'custom-pages/ai-assistant' local/backstage/app-config.ai.yaml   # disabled: true/false?
./scripts/bootstrap-ai.sh                                                # deploy the stack (adds --adp for approvals)
./scripts/bootstrap-local.sh --start-backstage                           # restart to pick up the config
```

If the file doesn't exist at all, `docker compose up` will bind-mount a directory in its place
and Backstage will fail to parse it — run either bootstrap script to regenerate it.

### "AI assistant did not respond (no session created)"

KAgent is not running or the proxy target is wrong.

```bash
# Check KAgent pods
kubectl get po -n kagent

# Check the proxy is reachable from Backstage
# (in the Backstage container or from the host)
curl http://kagent.idp.local/api/sessions
```

### Agent resets to "what would you like to do?"

This was caused by two bugs, both now fixed:
1. `get_template_params` was missing from the agent's `toolNames` list — the tool
   call failed silently and the agent lost its place in the scaffold flow.
2. The system message allowed the agent to ask "Should I proceed?" — when the user
   replied in a new message the previous context was not available, causing a reset.

**Fix applied:** Both issues are now fixed in the source: `get_template_params` is implemented in `services/idp-mcp-server/src/index.ts` and listed in `kubernetes/kagent/idp-agent.yaml` toolNames. Rule 4 + Rule 5 now require immediate `scaffold_service` invocation.

---

## AI-Native Platform (Phase 7a Complete)

The platform has been enhanced with comprehensive AI capabilities beyond the chat assistant:

### Multi-Provider Model Support ✅

Deploy agents using **Claude Anthropic** (default) or **OpenAI GPT-4o**:

```bash
# Both ModelConfigs available via kubernetes/kagent/
# - modelconfig-anthropic.yaml (Claude Haiku / Sonnet)
# - modelconfig-openai.yaml (GPT-4o)

# Use in agent spec:
#   modelConfig: claude-anthropic
#   # or
#   modelConfig: openai-prod
```

**Setup:** Set `OPENAI_API_KEY` in `local/.env` before running `./scripts/bootstrap-ai.sh`.

### Model Serving & Inference ✅

Deploy trained models as inference APIs:

```bash
# Via Backstage:
# Create → Model Serving API
# → Ollama (local Kind) or vLLM (AWS EKS with GPU)

# Manually:
helm upgrade --install my-model helm/service-template \
  --set image.repository=localhost:5003/my-model \
  --namespace ml-platform
```

Custom action: `idp:deploy-model-server` with secure TLS verification.

### AI Platform Scorecard ✅

Quality gates for AI services (Bronze/Silver/Gold tiers):

- **Bronze:** Agent deployed + health checks passing
- **Silver:** + deepeval CI eval suite + Grafana observability dashboard
- **Gold:** + cost attribution labels + system prompt versioned in ConfigMap

View in Backstage **Tech Insights** tab on any service entity. Three new checks: `has-model-card`, `has-eval-suite`, `has-ai-observability`.

### Prompt Lifecycle Management

System prompts live inline as `systemMessage` on each KAgent `Agent` CRD in
`kubernetes/kagent/<agent>.yaml` — one file per agent, versioned in Git:

- Version history and diffs come from Git history on the agent manifest
- Rollback is an ArgoCD revert of that manifest
- Editing a prompt means editing the CRD; the KAgent controller reconciles the change

```bash
# Edit the prompt in Git (preferred — ArgoCD reconciles the change):
$EDITOR kubernetes/kagent/release-agent.yaml   # spec.systemMessage

# Or, to try a prompt change against the live cluster before committing:
kubectl edit agent release-agent -n kagent
```

Extracting prompts into standalone ConfigMaps (with a Backstage "Update Agent Prompt"
template as the front door) is **not implemented** — there is no `kubernetes/kagent/prompts/`
directory. Note this also means the Gold-tier "system prompt versioned in ConfigMap"
scorecard item above is satisfied by Git versioning of the CRD, not by a separate ConfigMap.

### ML Workflows (Argo Workflows) ✅

Multi-step training + evaluation pipelines:

```bash
# Install (optional):
./scripts/bootstrap-local.sh --install-argo-workflows

# Access at: http://argo-workflows.idp.local

# Scaffold pipeline:
# Create → ML Training Job → outputs Argo Workflow YAML
```

### Cost Attribution ✅

Track AI API spend per team:

- Team labels on all Agent CRDs (`team: platform`, `team: quality`)
- `ai_api_calls_total` metric with `{server, model, tool}` labels
- Grafana dashboard: cost per team / model

### RAG Semantic Search ✅

AI search across TechDocs, runbooks, catalog:

```bash
# Via Backstage AI Assistant:
/ai-search

# Search query: "how to debug deployment failures"
# → Returns relevant runbooks, ADRs, documentation
```

Backend: Voyage AI embeddings + pgvector. The vector store is the Backstage Postgres itself — the `pgvector/pgvector` image in `local/backstage/docker-compose.yml`, initialised by `local/backstage/init-pgvector.sql`; on AWS, the `vector` extension on the same Aurora/RDS instance.

### AI Observability Dashboard ✅

Monitor MCP servers in Grafana:

- Tool call rate per server (idp, qa, contract)
- Call latency P50/P95/P99
- Error rates and retry patterns
- Token usage per model (if available)

Dashboard: **Grafana** → "AI Platform"

---

## Re-applying after a cluster rebuild

`bootstrap-ai.sh` applies all agents, MCP servers, and ModelConfigs automatically.
To target specific resources manually:

```bash
# Redeploy a single MCP server
helm upgrade --install github-mcp-server helm/service-template \
  --namespace services-dev --create-namespace \
  --values services/github-mcp-server/helm-values-local.yaml --wait

# Re-apply all KAgent resources
kubectl apply -f kubernetes/kagent/modelconfig-sonnet.yaml
kubectl apply -f kubernetes/kagent/toolserver.yaml
kubectl apply -f kubernetes/kagent/platform-agent.yaml
kubectl apply -f kubernetes/kagent/github-toolserver.yaml

# Rebuild a service image after code changes
cd services/github-mcp-server && docker build -t localhost:5003/github-mcp-server:0.1.0 . && docker push localhost:5003/github-mcp-server:0.1.0
kubectl rollout restart deployment/github-mcp-server -n services-dev
```

## What's next

Sprints 1-4 above are delivered and documented in this file. The remaining roadmap
(incident/security agents, RAG expansion, HiTL approval + Policy-as-Prompt) has been
reorganized into the **Agentic Development Platform (ADP)** epic — see
[agentic-platform.md](agentic-platform.md) for the phased plan and current status.

### Scaffold task stuck in "processing"

```bash
# Check task status directly in Backstage
open http://backstage.idp.local/create/tasks/<task-id>

# Check the scaffolder backend logs
kubectl logs -n backstage -l app=backstage --tail=50
```

### "No description available" for agent tools in KAgent UI

The KAgent controller connects to the MCP server to fetch tool metadata via `tools/list`.
If a tool is listed in the agent's `toolNames` but not exported by the MCP server, the controller cannot resolve all tools and displays "No description available" for all of them.

Check the controller logs:
```bash
kubectl logs -n kagent deployment/kagent-controller --tail=30 | grep -E "error|registered"
```

If you see `no such host: idp-mcp-server.services-dev.svc.cluster.local`, the MCP server is not deployed:
```bash
kubectl get pods -n services-dev
# If missing, deploy manually:
helm upgrade --install idp-mcp-server helm/service-template \
  --namespace services-dev --create-namespace \
  --values services/idp-mcp-server/helm-values-local.yaml --wait
```

### "No metrics found for …"

The service's `/metrics` endpoint is not yet scraped. Check that a `ServiceMonitor`
exists in the `services` namespace and that Prometheus has discovered it:

```bash
kubectl get servicemonitor -n services
# Then check Prometheus targets: http://prometheus.idp.local/targets
```

---

## Rebuilding the IDP MCP Server image

After any code change to `services/idp-mcp-server/`:

```bash
./scripts/bootstrap-ai.sh --skip-mlflow --skip-kagent
# Rebuilds and pushes the idp-mcp-server image only, then reloads the deployment
```

Or manually:
```bash
docker build -t localhost:5003/idp-mcp-server:latest services/idp-mcp-server/
docker push localhost:5003/idp-mcp-server:latest
kubectl rollout restart deployment/idp-mcp-server -n kagent
```

---

## AI Search (Semantic / RAG)

The `/ai-search` page in Backstage provides semantic search over the service catalog
**and rendered TechDocs content** (runbooks, architecture docs, this file) using
[Voyage AI](https://www.voyageai.com) embeddings stored in pgvector.

### Architecture

```
Browser → Backstage frontend (AiSearchPage)
            ↓  GET /api/rag-search/search?q=<query>
          Backstage backend (idpRagSearch plugin)
            ↓  Voyage AI API (voyage-3-lite, 512-dim)
            ↓  PostgreSQL + pgvector (HNSW cosine similarity)
            → top-10 results with similarity score

Indexing (every 30 min, or POST /api/rag-search/index):
  1. Catalog entities — GET {catalogBase}/entities (description, tags, owner)
  2. External sources — ragSearch.externalSources config (optional, off by default)
  3. TechDocs pages — for every entity with a backstage.io/techdocs-ref annotation,
     fetch {techdocsBase}/static/docs/<namespace>/<kind>/<name>/search/search_index.json
     (the same per-entity search index the TechDocs UI's own search box reads) and
     index each page's rendered text. This goes through the techdocs-backend, so it
     works the same whether the publisher is local filesystem (Kind) or S3 (AWS) —
     it does NOT read markdown source files directly.
```

### Prerequisites

Add your Voyage AI API key to `local/backstage/.env`:

```bash
VOYAGE_API_KEY=your-key-here
```

Sign up at https://www.voyageai.com — the free tier provides 200M tokens/month,
which is more than sufficient for a local IDP catalog.

Without `VOYAGE_API_KEY`, the `/ai-search` page loads but returns HTTP 503 on every
search. All other Backstage features are unaffected.

### How pgvector is provisioned

`local/backstage/docker-compose.yml` uses the `pgvector/pgvector:pg17` image instead
of plain `postgres:17-alpine`. On the first container startup (empty volume),
`local/backstage/init-pgvector.sql` is executed automatically via
`docker-entrypoint-initdb.d`. It:

1. Creates the `vector` extension
2. Creates the `rag_documents` table (512-dim embedding column + metadata)
3. Creates an HNSW index for fast cosine-similarity search

This runs automatically — no manual SQL step required. After a cluster destroy +
`--start-backstage`, the volume is re-created and the SQL runs again on the fresh
Postgres instance.

### Backend plugin

**File:** `backstage/app/packages/backend/src/modules/idpRagSearch.ts`

Registered in `backend/src/index.ts` as `ragSearchPlugin`. Exposes three endpoints:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/rag-search/search?q=<query>` | GET | Returns top-10 semantically similar results (catalog entities + TechDocs pages) |
| `/api/rag-search/index` | POST | Triggers a manual re-index of catalog entities + TechDocs pages |
| `/api/rag-search/status` | GET | Returns last-indexed timestamp and document count |

The plugin auto-indexes the catalog and TechDocs every 30 minutes (configurable via
`ragSearch.indexIntervalMinutes` in `app-config.yaml`). A page only gets indexed once its
TechDocs site has been built at least once (visit the entity's Docs tab, or wait for the
scheduled TechDocs build) — the indexer reads the already-built `search_index.json`, it
does not trigger a TechDocs build itself.

### Configuration (`app-config.yaml`)

```yaml
ragSearch:
  voyageApiKey: ${VOYAGE_API_KEY}
  indexIntervalMinutes: 30
  externalSources: []   # optional list of documentation URLs to include
```

### Troubleshooting

**Search returns 503**

`VOYAGE_API_KEY` is missing or empty in `local/backstage/.env`. Add the key and
restart Backstage (`./scripts/bootstrap-local.sh --start-backstage`).

**No results / stale results**

Trigger a manual re-index:
```bash
curl -X POST http://backstage.idp.local/api/rag-search/index
# Or click the "Re-index" button on the /ai-search page
```

Check indexing status:
```bash
curl http://backstage.idp.local/api/rag-search/status
```

**pgvector extension missing**

The `rag_documents` table won't exist if Backstage was started before the
`init-pgvector.sql` fix was committed. Tear down and restart Docker Compose:

```bash
docker compose -f local/backstage/docker-compose.yml down -v
./scripts/bootstrap-local.sh --start-backstage
```
