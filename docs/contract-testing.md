# Contract Testing with MCP

Self-describing, self-testing APIs on the IDP — powered by the `contract-mcp-server` and the `contract-assistant` KAgent agent.

---

## The Problem

Static OpenAPI specs drift. Manually maintained Pact suites break silently. Most teams only discover API incompatibilities in production.

## The Solution

Every service exposes its own live contract via `GET /openapi.json`. The `contract-mcp-server` collects those contracts, generates Pact consumer tests automatically, detects breaking changes between versions, and validates compatibility across the whole platform. The `contract-assistant` AI agent wraps all of this as natural-language workflows.

```
Service deploys
    │
    ▼
/openapi.json (self-describing)
    │
    ▼
contract-mcp-server ─── register_contract ──► contract registry
    │                                          (in-memory, port 3003)
    ├── generate_contract_tests ─────────────► Pact JSON + TypeScript
    ├── detect_breaking_changes ─────────────► diff two versions
    ├── validate_compatibility ──────────────► consumer ✓/✗ provider
    ├── get_compatibility_report ────────────► full matrix
    ├── fetch_service_contract ──────────────► pull spec from live service
    └── auto_discover_contracts ─────────────► scan entire namespace
```

---

## Access Points

| Interface | URL | What you can do |
|-----------|-----|-----------------|
| KAgent UI | http://kagent.idp.local | Chat with `contract-assistant` agent |
| Backstage AI Assistant | http://backstage.idp.local/ai-assistant | Same agent, inside Backstage |
| Backstage Catalog | http://backstage.idp.local/create | Run the `contract-testing-suite` scaffold template |
| Contract MCP Server API | http://contract-mcp-server.idp.local | Direct MCP tool calls (POST /mcp) |
| Contract MCP Server health | http://contract-mcp-server.idp.local/healthz | Health check |

---

## How to Make a Service Self-Describing

Add a `GET /openapi.json` endpoint to your service. It must return a valid OpenAPI 3.x document.

### Go (reference: hello-service)

```go
mux.HandleFunc("/openapi.json", handleOpenAPISpec)

func handleOpenAPISpec(w http.ResponseWriter, r *http.Request) {
    spec := map[string]any{
        "openapi": "3.0.3",
        "info": map[string]any{
            "title":   "My Service",
            "version": version, // inject the running binary version
        },
        "paths": map[string]any{
            "/healthz": map[string]any{
                "get": map[string]any{
                    "summary": "Liveness probe",
                    "responses": map[string]any{
                        "200": map[string]any{"description": "OK"},
                    },
                },
            },
            // ... add every route your service exposes
        },
    }
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(spec)
}
```

### Node.js / Express

```typescript
app.get('/openapi.json', (_req, res) => {
  res.json({
    openapi: '3.0.3',
    info: { title: 'My Service', version: process.env.APP_VERSION ?? 'dev' },
    paths: {
      '/healthz': { get: { summary: 'Health check', responses: { '200': { description: 'OK' } } } },
    },
  });
});
```

Once the endpoint exists, any deployed service is automatically discoverable by the contract platform.

---

## Workflows

### 1 — Auto-discover contracts for an entire namespace

Ask the contract-assistant or call directly:

**Agent prompt:**
> "Discover contracts for all services in the services-dev namespace"

**Direct MCP call:**
```bash
curl -s http://contract-mcp-server.idp.local/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"auto_discover_contracts","arguments":{"namespace":"services-dev","port":80}}}' \
  | grep '^data:' | sed 's/^data: //'
```

Every service that exposes `/openapi.json` is registered automatically. Services without the endpoint are listed as `no_spec` — add the endpoint to include them.

---

### 2 — Pull a single service's contract

**Agent prompt:**
> "Fetch the contract for hello-service"

**Direct call:**
```bash
curl -s http://contract-mcp-server.idp.local/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"fetch_service_contract","arguments":{"service_name":"hello-service-local-service-template","namespace":"services-dev","port":80}}}' \
  | grep '^data:' | sed 's/^data: //'
```

---

### 3 — Generate consumer-driven contract tests

**Agent prompt:**
> "Generate Pact tests for hello-service consumed by frontend-app"

Returns two artifacts:
- **`pactJson`** — drop into `./pacts/frontend-app-hello-service.json`, publishable to a Pact broker
- **`testCode`** — TypeScript test file using `@pact-foundation/pact` v12

---

### 4 — Validate compatibility

**Agent prompt:**
> "Is frontend-app compatible with the current hello-service spec?"

Returns `✓ COMPATIBLE` or `✗ INCOMPATIBLE — missing paths: ["/api/v2/users"]`.

---

### 5 — Detect breaking changes before a deploy

Register the new spec during CI (before deploying):

```bash
# In your CI pipeline — after building the new version
NEW_SPEC=$(cat openapi.json | jq -Rs .)
curl -s http://contract-mcp-server.idp.local/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"register_contract\",\"arguments\":{\"service_name\":\"my-service\",\"version\":\"${NEW_TAG}\",\"openapi_spec\":${NEW_SPEC}}}}" \
  | grep '^data:' | sed 's/^data: //'
```

Then check for breaking changes:

**Agent prompt:**
> "Are there breaking changes between my-service v1.2.0 and v2.0.0?"

**Direct call:**
```bash
curl -s http://contract-mcp-server.idp.local/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"detect_breaking_changes","arguments":{"service_name":"my-service","from_version":"1.2.0","to_version":"2.0.0"}}}' \
  | grep '^data:' | sed 's/^data: //'
```

Breaking changes detected: `type: path_removed`, `method_removed`, or `required_param_added`.

---

### 6 — Full compatibility report

**Agent prompt:**
> "Show the compatibility report for hello-service"

Returns a matrix: every registered service as a potential consumer, pass/fail, and missing paths if incompatible.

---

## Backstage Template — contract-testing-suite

Generate a full contract test project in one click.

1. Open **Backstage → Create** → search **"Contract Testing Suite"**
2. Fill in:
   - **Consumer name** — your service (the one making API calls)
   - **Provider name** — the service being contracted
   - **Provider base URL** — where the provider runs locally
3. Choose **new-repository** or **add-to-existing**
4. Click **Create**

The scaffold generates:
- `contract/openapi.yaml` — consumer's expected contract (edit to match your actual API calls)
- `tests/<name>.pact.spec.ts` — Pact V3 consumer tests
- `.github/workflows/contract.yml` — CI workflow that runs tests and auto-registers the spec
- `catalog-info.yaml` — registers in Backstage catalog

---

## Helm Chart Hooks — ArgoCD Self-Testing

Any service using `helm/service-template` can opt into automatic contract checking on every ArgoCD sync.

### PostSync hook (self-describing + self-testing after every deploy)

```yaml
# helm-values-local.yaml
contractCheck:
  enabled: true
  mcpServerUrl: "http://contract-mcp-server.services-dev.svc.cluster.local:3003"
```

After every sync, ArgoCD runs a Job that:
1. Calls `fetch_service_contract` — pulls `/openapi.json` and registers the running spec
2. Calls `get_compatibility_report` — logs compatibility status for all consumers

### PreSync hook (block deploy on breaking changes)

```yaml
contractCheck:
  enabled: true
  checkBreaking: true
  fromVersion: "1.2.0"   # currently deployed (set by CI)
  toVersion: "2.0.0"     # being deployed    (set by CI)
```

Before syncing, ArgoCD runs a Job that calls `detect_breaking_changes`. If any breaking change is found, the Job exits 1 — **the sync is blocked**.

Typical CI pattern:

```yaml
# .github/workflows/build-and-deploy.yml
- name: Register new spec and check breaking changes
  run: |
    NEW_SPEC=$(kubectl exec -n services deploy/my-service -- wget -qO- http://localhost:8080/openapi.json | jq -Rs .)
    # register the new version
    curl -sf $CONTRACT_MCP_URL/mcp -H "..." -d "{...register_contract v${NEW_TAG}...}"
    # get current deployed version from image tag
    CURRENT_TAG=$(kubectl get deploy/my-service -n services -o jsonpath='{.spec.template.spec.containers[0].image}' | cut -d: -f2)
    # pass versions to Helm for PreSync check
    helm upgrade my-service helm/service-template \
      --set contractCheck.fromVersion=${CURRENT_TAG} \
      --set contractCheck.toVersion=${NEW_TAG} \
      ...
```

---

## Contract-Assistant Agent — Quick Reference

Open http://kagent.idp.local and select **contract-assistant**, or use the Backstage AI Assistant.

| Goal | Prompt |
|------|--------|
| Make platform self-describing | *"Discover contracts for all services in services-dev"* |
| Pull one service's spec | *"Fetch the contract for hello-service"* |
| Generate Pact tests | *"Generate contract tests for hello-service consumer frontend-app"* |
| Check compatibility | *"Is frontend-app compatible with hello-service?"* |
| Detect breaking changes | *"Breaking changes between my-service v1.0.0 and v2.0.0?"* |
| Full audit | *"Show the compatibility report for hello-service"* |
| List all registered | *"List all registered contracts"* |

---

## MCP Tool Reference

All tools are callable via `POST /mcp` with `Accept: application/json, text/event-stream`.

| Tool | Description |
|------|-------------|
| `fetch_service_contract` | Pull `/openapi.json` from a running service and auto-register it |
| `auto_discover_contracts` | Scan every service in a namespace, register all that expose `/openapi.json` |
| `register_contract` | Manually push an OpenAPI spec (JSON or YAML string) |
| `get_contract` | Retrieve a stored contract (latest or specific version) |
| `list_contracts` | List all registered services and their versions |
| `generate_contract_tests` | Return Pact JSON + TypeScript test code from a provider spec |
| `validate_compatibility` | Check if provider spec covers all consumer-expected paths |
| `detect_breaking_changes` | Diff two spec versions — removed paths, methods, new required params |
| `get_compatibility_report` | Full consumer/provider compatibility matrix for a service |

---

## Troubleshooting

**`fetch_service_contract` returns "No OpenAPI spec found"**
The service does not expose `/openapi.json`. Add the endpoint (see above) and redeploy.

**`auto_discover_contracts` shows all services as `no_spec`**
Either the services do not expose `/openapi.json`, or the port is wrong. Most services listen on port 80 via their K8s Service. Pass `"port": 80`.

**`detect_breaking_changes` says "version not found"**
The version must be pre-registered with `register_contract` before you can diff it. Register the new version in CI before deploying.

**KAgent `contract-assistant` shows READY=False**
```bash
kubectl rollout restart deployment/kagent-controller -n kagent
kubectl get agents -n kagent contract-assistant
```

**Redeploy contract-mcp-server after a code change:**
```bash
cd services/contract-mcp-server
docker build -t localhost:5003/contract-mcp-server:0.1.0 .
docker push localhost:5003/contract-mcp-server:0.1.0
kubectl rollout restart deployment/contract-mcp-server -n services-dev
```
