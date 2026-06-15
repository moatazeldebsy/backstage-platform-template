# AI Assistant

The AI Assistant is a chat interface embedded in the Backstage portal backed by
[KAgent](https://kagent.dev) AI agents (Claude) with live access to the service
catalog, Prometheus metrics, Kubernetes deployments, Backstage scaffolder, test
suites, contract testing, GitHub PRs, and persistent user memory.

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
└────────────┬──────────────┬──────────────┬────────────┬──────────┘
             │ MCP/HTTP     │              │            │
             ▼              ▼              ▼            ▼
    ┌──────────────┐ ┌──────────┐ ┌──────────────┐ ┌──────────────┐
    │ idp-mcp      │ │ qa-mcp   │ │ contract-mcp │ │ github-mcp   │
    │ :3001        │ │ :3002    │ │ :3003        │ │ :3005        │
    │ 9 tools      │ │ 4 tools  │ │ 9 tools      │ │ 3 tools      │
    └──────────────┘ └──────────┘ └──────────────┘ └──────────────┘

Event Bus (agent-event-router :3004)
  ← GitHub webhooks (PR open/update → qa-assistant)
  ← AlertManager webhooks (firing alerts → idp-assistant)
  ← ArgoCD webhooks (OutOfSync/Degraded → idp-assistant)
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

Specialist agents are still available at `/a2a/kagent/<name>` but `platform-assistant`
is the recommended entry point for all developer interactions.

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

**Secret:** `github-mcp-server-token` in `services-dev` namespace, key `token`.
Optional locally (warns on startup if missing), required in AWS.

**Used by:** `qa-assistant` for automated PR review; `platform-assistant` for cross-domain queries.

---

### 5. Event Bus — `agent-event-router`

**File:** `services/agent-event-router/src/index.ts`

A small Express service (port 3004) that receives webhooks from GitHub, AlertManager,
and ArgoCD and fans out to agents via A2A. This is what makes agents **proactive** —
they respond to platform events without a human initiating the conversation.

| Source | Trigger | Target agent | Action |
|--------|---------|--------------|--------|
| GitHub | `pull_request` opened/updated | `qa-assistant` | Review test coverage, post PR comment |
| GitHub | `push` to main | `idp-assistant` | Notify of new deployment candidate |
| AlertManager | `firing` alert (critical/warning) | `idp-assistant` | Diagnose + suggest remediation |
| ArgoCD | App `OutOfSync` or `Degraded` | `idp-assistant` | Check sync status |

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

Every tool call on the `idp-mcp-server` and `contract-mcp-server` emits a structured `[AUDIT]` JSON line to stdout:

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

## Troubleshooting

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

### Prompt Lifecycle Management ✅

System prompts extracted to ConfigMaps in `kubernetes/kagent/prompts/`:

- Zero-downtime prompt updates (no pod restart)
- Version history via Git history
- Rollback via ArgoCD revert

```bash
# Update via Backstage:
# Create → Update Agent Prompt → PR to kubernetes/kagent/prompts/<agent>-prompt.yaml
# Or edit directly: kubectl edit configmap idp-assistant-prompt -n kagent
```

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

Backend: Voyage AI embeddings + pgvector (`kubernetes/pgvector.yaml`).

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

## What's next (Sprint 4+)

| Sprint | Features |
|--------|---------|
| Sprint 4 | `argocd-mcp-server` + `release-agent` + `cost-mcp-server` + `cost-agent` |
| Sprint 5 | `incident-mcp-server` + `incident-agent` + `notification-mcp-server` |
| Sprint 6 | RAG expansion (runbooks, ADRs) + hallucination detection + Ollama ModelConfig |
| Sprint 7 | `security-mcp-server` + `security-agent` + `onboarding-agent` |
| Sprint 8 | HiTL approval workflow + Policy-as-Prompt |

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
using [Voyage AI](https://www.voyageai.com) embeddings stored in pgvector.

### Architecture

```
Browser → Backstage frontend (AiSearchPage)
            ↓  GET /api/rag-search/search?q=<query>
          Backstage backend (idpRagSearch plugin)
            ↓  Voyage AI API (voyage-3-lite, 512-dim)
            ↓  PostgreSQL + pgvector (HNSW cosine similarity)
            → top-10 results with similarity score
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
| `/api/rag-search/search?q=<query>` | GET | Returns top-10 semantically similar catalog entities |
| `/api/rag-search/index` | POST | Triggers a manual re-index of the catalog |
| `/api/rag-search/status` | GET | Returns last-indexed timestamp and document count |

The plugin auto-indexes the full catalog every 30 minutes (configurable via
`ragSearch.indexIntervalMinutes` in `app-config.yaml`).

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
