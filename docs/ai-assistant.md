# AI Assistant

The AI Assistant is a chat interface embedded in the Backstage portal backed by a
[KAgent](https://kagent.dev) AI agent (Claude) that has live access to the service
catalog, Prometheus metrics, Kubernetes deployments, and the Backstage scaffolder.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Backstage (Docker Compose / EKS pod)                            │
│                                                                  │
│  extensions.tsx — AiAssistantPage                                │
│    POST /api/proxy/kagent/a2a/kagent/idp-assistant               │
│    GET  /api/proxy/kagent/api/sessions/<id>  (poll)              │
└───────────────────────┬──────────────────────────────────────────┘
                        │  Backstage proxy
                        ▼
┌──────────────────────────────────────────────────────────────────┐
│  KAgent UI  (namespace: kagent)                                  │
│  kagent-ui.kagent.svc.cluster.local:8080  (in-cluster)          │
│  http://kagent.idp.local  (local ingress)                        │
│                                                                  │
│  A2A server — routes /a2a/kagent/<agent-name>                   │
│  Sessions API — GET /api/sessions/:id                            │
└───────────────────────┬──────────────────────────────────────────┘
                        │  MCP over HTTP
                        ▼
┌──────────────────────────────────────────────────────────────────┐
│  IDP MCP Server  (namespace: kagent)                             │
│  service: idp-mcp-server  port: 3001                             │
│  POST /mcp  (Streamable HTTP, stateless, one McpServer/request)  │
│                                                                  │
│  Tools:                                                          │
│    catalog_search       → Backstage catalog API                  │
│    get_service_metrics  → Prometheus query API                   │
│    list_templates       → Backstage catalog (kind=Template)      │
│    get_template_params  → Backstage catalog entity by name       │
│    scaffold_service     → Backstage scaffolder v2 tasks API      │
│    list_deployments     → Kubernetes apps/v1 Deployments API     │
└──────────────────────────────────────────────────────────────────┘
```

---

## Component breakdown

### 1. Backstage frontend — `AiAssistantPage`

**File:** `backstage/app/packages/app/src/extensions.tsx`

Registered as a Backstage frontend plugin extension at route `/ai-assistant` with a
nav item (chat icon) in the sidebar.

**Message flow per user turn:**

```
1. Generate a UUID contextId (used to locate the session after creation)
2. POST /api/proxy/kagent/a2a/kagent/idp-assistant  { jsonrpc: "2.0", method: "message/send", … }
   — fire and ignore the SSE response (KAgent streams SSE, not JSON)
3. Poll GET /api/proxy/kagent/api/sessions  every 500 ms for up to 12 s
   — find the session whose id matches contextId (or the most-recent idp_assistant session)
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

### 3. KAgent agent manifest

**File:** `kubernetes/kagent/idp-agent.yaml`

```yaml
apiVersion: kagent.dev/v1alpha2
kind: Agent
metadata:
  name: idp-assistant
  namespace: kagent
spec:
  type: Declarative
  declarative:
    modelConfig: claude-anthropic   # references kubernetes/kagent/modelconfig.yaml
    systemMessage: |
      …
    tools:
      - type: McpServer
        mcpServer:
          kind: RemoteMCPServer
          name: idp-mcp-server
          namespace: kagent
          toolNames:
            - catalog_search
            - get_service_metrics
            - get_template_params
            - scaffold_service
            - list_deployments
            - list_templates
```

**System message rules (summarised):**

| Rule | Behaviour |
|------|-----------|
| 1 | Never reference templates from memory — always call `list_templates` first |
| 2 | Never call `ask_user` or any interactive confirmation tool |
| 3 | Ask for missing info as plain text; wait for the next user message |
| 4 | Scaffold flow: `list_templates` → `get_template_params` → `scaffold_service` — **immediately, no confirmation prompt** |
| 5 | Minimum required fields to scaffold: `name`, `description`, `owner` — proceed without asking when all three are present |
| 6 | Catalog/metric/deployment: call the relevant tool immediately |
| 7 | Be concise; show real tool results, not assumptions |

**Why Rule 4 + 5 matter:** If the agent asks "Should I proceed?" and the user replies
in a new message, the agent loses the scaffolding context (the previous tool results
are not re-sent) and resets to its opening prompt. The fix was to prohibit confirmation
questions entirely and call `scaffold_service` in the same response turn.

---

### 4. IDP MCP Server

**File:** `services/idp-mcp-server/src/index.ts`

Node.js/TypeScript process exposed on port `3001`. Uses the
`@modelcontextprotocol/sdk` Streamable HTTP transport. Because `McpServer.connect()`
can only be called once per instance, a fresh `McpServer` is created per request
(`createServer()` factory).

| Tool | Upstream call | Notes |
|------|--------------|-------|
| `catalog_search` | `GET /api/catalog/entities` | Exact-match first, falls back to client-side fuzzy filter (200 entities) |
| `get_service_metrics` | Prometheus `/api/v1/query` | Defaults to `http_requests_total` |
| `list_templates` | `GET /api/catalog/entities?filter=kind=Template` | Returns name, title, description, templateRef |
| `get_template_params` | `GET /api/catalog/entities/by-name/Template/default/<name>` | Flattens all parameter groups into a single list with required/optional flags |
| `scaffold_service` | `POST /api/scaffolder/v2/tasks` then polls status | Auto-builds `repoUrl` from `name`+`owner` if omitted; normalises full HTTPS GitHub URLs; polls for up to 3 min |
| `list_deployments` | Kubernetes `/apis/apps/v1/namespaces/<ns>/deployments` | Defaults to namespace `services`; uses in-cluster service account token |

**Environment variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `BACKSTAGE_URL` | `http://backstage:7007` | Internal Backstage URL |
| `BACKSTAGE_EXTERNAL_URL` | `http://backstage.idp.local` | Browser-accessible URL (used in task output links) |
| `BACKSTAGE_TOKEN` | *(empty)* | Static token from `app-config.local.yaml` |
| `PROMETHEUS_URL` | `http://prometheus-kube-prometheus-prometheus.monitoring:9090` | In-cluster Prometheus |
| `K8S_API` | `https://kubernetes.default.svc` | In-cluster Kubernetes API |
| `K8S_TOKEN` | *(empty)* | Falls back to in-cluster service account token |
| `PORT` | `3001` | HTTP listen port |

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

**Fix applied:** `kubernetes/kagent/idp-agent.yaml` — `get_template_params` added to
`toolNames`; Rule 4 + Rule 5 now require immediate `scaffold_service` invocation.

To re-apply after a cluster rebuild:
```bash
kubectl apply -f kubernetes/kagent/idp-agent.yaml
# (bootstrap-ai.sh does this automatically on every run)
```

### Scaffold task stuck in "processing"

```bash
# Check task status directly in Backstage
open http://backstage.idp.local/create/tasks/<task-id>

# Check the scaffolder backend logs
kubectl logs -n backstage -l app=backstage --tail=50
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
