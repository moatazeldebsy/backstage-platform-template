# Contract Testing with MCP

Self-describing, self-testing APIs on the IDP — powered by `contract-mcp-server` and the `contract-assistant` KAgent agent.

---

## The Problem

Static OpenAPI specs drift from reality. Manually maintained Pact suites break silently. Most teams only discover API incompatibilities in production, after a consumer has already deployed against a provider that changed an endpoint.

## The Solution

Every service exposes its live contract via `GET /openapi.json`. The `contract-mcp-server` collects those contracts, generates Pact consumer tests automatically (with realistic schema matchers, not just status codes), detects breaking changes between versions, and validates compatibility across the whole platform. The `contract-assistant` AI agent wraps all of this as natural-language workflows.

---

## Using Contract Testing from Backstage

Everything below is available directly from the Backstage UI — no CLI, no `curl`, no local setup required.

### 1. Chat with the AI Assistant

Open **http://backstage.idp.local/ai-assistant** and select the **contract-assistant** agent. Use plain English:

| Goal | What to type |
|------|-------------|
| Onboard a service | *"Fetch and register the contract for payments-api in services-prod"* |
| Discover all services in a namespace | *"Discover contracts for all services in services-dev"* |
| Generate Pact consumer tests | *"Generate Pact tests for checkout-service consuming payments-api v1.2.0"* |
| Check if a consumer is compatible | *"Is checkout-service compatible with the latest payments-api?"* |
| Get a full compatibility matrix | *"Show the compatibility report for payments-api"* |
| Detect breaking changes | *"Did anything break between payments-api v1.0.0 and v2.0.0?"* |
| Inspect a registered contract | *"Show me the contract for inventory-service"* |
| List all registered services | *"List all registered contracts"* |

The agent automatically calls the right underlying tool and returns a human-readable summary. For `generate_contract_tests`, it returns both the TypeScript test file and the Pact JSON inline — paste them into your repo.

### 2. Scaffold a Contract Test Project

Open **http://backstage.idp.local/create** and choose one of two templates:

**Contract Testing Suite** — for new consumer test projects:
1. Search `Contract Testing Suite` → click **Choose**
2. Fill in consumer name, provider name, provider base URL, Pact broker URL
3. Choose **new-repository** (creates a standalone repo) or **add-to-existing** (opens a PR against your service repo)
4. Click **Create** — Backstage scaffolds:
   - `tests/<name>.pact.spec.ts` — Pact V3 tests with MatchersV3 matchers
   - `contract/openapi.yaml` — editable consumer contract
   - `.github/workflows/contract.yml` — CI: run → publish → verify
   - `catalog-info.yaml` — registers the test suite in the Backstage catalog

**Enable Contract Testing** — one-click onboarding for an existing service:
1. Search `Enable Contract Testing` → click **Choose**
2. Enter your service name and namespace
3. Click **Create** — Backstage auto-discovers the service's live `/openapi.json`, registers it, and wires an ArgoCD hook so every future deploy re-registers automatically

### 3. View Contract Status in the Catalog

After onboarding, your service's contract status is visible in the **Backstage Catalog**:
- `catalog-info.yaml` entities of type `test-suite` link back to their provider
- The `contract-assistant` agent can be asked about any catalog entity by name

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              PLATFORM OVERVIEW                                  │
└─────────────────────────────────────────────────────────────────────────────────┘

  ┌──────────────────────────┐    ┌──────────────────────────┐
  │  hello-service (K8s)     │    │  payments-api (K8s)       │
  │  GET /openapi.json  ─────┼─┐  │  GET /openapi.json  ─────┼─┐
  └──────────────────────────┘ │  └──────────────────────────┘ │
                               │                               │
                               └──────────────┬────────────────┘
                                              │ auto_discover_contracts
                                              │ fetch_service_contract
                                              ▼
                          ┌───────────────────────────────────────┐
                          │        contract-mcp-server :3003       │
                          │  ─────────────────────────────────── │
                          │  9 MCP tools  │  REST shim /api/...   │
                          │  ─────────────────────────────────── │
                          │  Storage: in-memory │ PostgreSQL       │
                          │           │ DynamoDB                   │
                          └──────┬────────────────────────────────┘
                                 │
              ┌──────────────────┼──────────────────────────┐
              │                  │                           │
              ▼                  ▼                           ▼
  ┌───────────────────┐  ┌───────────────────┐  ┌───────────────────────┐
  │  Pact JSON +      │  │  Breaking-change   │  │  Compatibility        │
  │  TypeScript test  │  │  Webhook           │  │  matrix report        │
  │  (schema matchers)│  │  (Slack / PD / GH) │  │  (all consumers)      │
  └───────────────────┘  └───────────────────┘  └───────────────────────┘
              │
              ▼
  ┌───────────────────────────────────────────────────────────────────────┐
  │                 CI / CD  (GitHub Actions)                              │
  │                                                                       │
  │  contract-check.yml                                                   │
  │  ├── Register PR spec as new version                                  │
  │  ├── detect_breaking_changes vs previous                              │
  │  ├── Post PR comment with diff                                        │
  │  └── Fail job if breaking → blocks merge                              │
  │                                                                       │
  │  ArgoCD PreSync hook                                                  │
  │  └── detect_breaking_changes → block deploy if breaking               │
  │                                                                       │
  │  ArgoCD PostSync hook                                                 │
  │  ├── fetch_service_contract  (register running version)               │
  │  └── get_compatibility_report (log consumer compat status)           │
  └───────────────────────────────────────────────────────────────────────┘
              ▲
              │
  ┌───────────────────────────────────────┐
  │  KAgent contract-assistant            │  ← natural-language queries
  │  AI orchestration over all 9 tools    │
  └───────────────────────────────────────┘
              ▲
              │
  ┌───────────────────────────────────────┐
  │  Backstage AI Assistant               │  ← same agent, IDP-embedded
  │  Backstage Scaffolder Templates       │  ← one-click onboarding
  └───────────────────────────────────────┘
```

---

## Components

| Component | Location | Purpose |
|-----------|----------|---------|
| `contract-mcp-server` | `services/contract-mcp-server/` | Central contract registry + MCP server |
| `contract-assistant` KAgent | `kubernetes/kagent/contract-agent.yaml` | AI agent for natural-language workflows |
| `contract-toolserver` | `kubernetes/kagent/contract-toolserver.yaml` | RemoteMCPServer CRD wiring |
| Backstage template — `contract-testing-suite` | `backstage/catalog/templates/contract-testing-suite/` | Scaffold a full Pact test project |
| Backstage template — `enable-contract-testing` | `backstage/catalog/templates/enable-contract-testing/` | One-click onboarding for existing services |
| GitHub Actions workflow | `.github/workflows/contract-check.yml` | Per-PR breaking change gate |
| Helm values | `services/contract-mcp-server/helm-values-*.yaml` | Kubernetes deployment config |

---

## Access Points

| Interface | URL | What you can do |
|-----------|-----|-----------------|
| KAgent UI | http://kagent.idp.local | Chat with `contract-assistant` |
| Backstage AI Assistant | http://backstage.idp.local/ai-assistant | Same agent, inside Backstage |
| Backstage Templates | http://backstage.idp.local/create | Scaffold a Pact test project |
| MCP endpoint | http://contract-mcp-server.idp.local/mcp | Direct JSON-RPC tool calls |
| REST API | http://contract-mcp-server.idp.local/api | Team-friendly HTTP API |
| Health | http://contract-mcp-server.idp.local/healthz | Storage type + discovery mode |
| Metrics | http://contract-mcp-server.idp.local/metrics | Prometheus counters + histograms |

---

## End-to-End Flows

### Flow 1 — Service onboards (self-describing)

```
1. Developer adds GET /openapi.json to their service
2. Service deploys to K8s
3. ArgoCD PostSync hook calls:
       fetch_service_contract("my-service", namespace="services-dev")
   → contract-mcp-server probes /openapi.json, registers the spec
4. get_compatibility_report("my-service")
   → logs which registered consumers are still compatible
```

### Flow 2 — PR breaks a consumer (CI gate)

```
1. Developer opens PR with a changed openapi.json
2. GitHub Actions (.github/workflows/contract-check.yml):
   a. GET /api/contracts/my-service  → fetch latest registered version
   b. POST /api/contracts/my-service/pr-{PR}-{SHA}  → register PR spec
   c. POST /api/breaking-changes {from_version, to_version}
      → response: { breaking: [{type: "path_removed", ...}] }
   d. if breaking.length > 0:
        post PR comment with diff
        exit 1  → PR cannot merge
3. Developer fixes the spec or deprecates the endpoint gracefully
```

### Flow 3 — Consumer generates their Pact tests

```
1. Provider spec is already registered (hello-service v1.2.0)
2. Consumer team calls generate_contract_tests:
       provider=hello-service, consumer=frontend-app
   → Returns:
       pactJson:  interactions with real request/response bodies
       testCode:  TypeScript using @pact-foundation/pact MatchersV3
                  like(), integer(), decimal(), regex(), eachLike()
3. Consumer saves pactJson → ./pacts/frontend-app-hello-service.json
4. Consumer saves testCode → ./tests/frontend-app-hello-service.pact.spec.ts
5. npm test  → Pact runs, publishes to Pact broker
```

### Flow 4 — AI agent workflow (natural language)

```
User:  "Discover contracts for all services in services-dev"
Agent: calls auto_discover_contracts(namespace="services-dev")
     → scans K8s services, probes /openapi.json, registers all found
     → reports: 7 discovered, 2 no_spec, 0 errors

User:  "Generate Pact tests for hello-service consumed by mobile-bff"
Agent: calls get_contract("hello-service")
     → fetches spec with schemas (parameters, requestBody, responses)
       calls generate_contract_tests("hello-service", "mobile-bff")
     → returns testCode with MatchersV3 matchers + pactJson

User:  "Are there breaking changes between v1.0.0 and v2.0.0?"
Agent: calls detect_breaking_changes("my-service", "1.0.0", "2.0.0")
     → returns: [{ type: "path_removed", path: "/v1/bulk" }]
```

---

## Making a Service Self-Describing

Add `GET /openapi.json` to your service. The response must be a valid OpenAPI 3.x document.

### Go (reference: hello-service)

```go
mux.HandleFunc("/openapi.json", func(w http.ResponseWriter, r *http.Request) {
    spec := map[string]any{
        "openapi": "3.0.3",
        "info":    map[string]any{"title": "My Service", "version": version},
        "paths": map[string]any{
            "/healthz": map[string]any{
                "get": map[string]any{
                    "summary":   "Health check",
                    "responses": map[string]any{"200": map[string]any{"description": "OK"}},
                },
            },
            "/api/v1/users": map[string]any{
                "post": map[string]any{
                    "summary": "Create user",
                    "requestBody": map[string]any{
                        "required": true,
                        "content": map[string]any{
                            "application/json": map[string]any{
                                "schema": map[string]any{
                                    "type":     "object",
                                    "required": []string{"name", "email"},
                                    "properties": map[string]any{
                                        "name":  map[string]any{"type": "string"},
                                        "email": map[string]any{"type": "string", "format": "email"},
                                    },
                                },
                            },
                        },
                    },
                    "responses": map[string]any{
                        "201": map[string]any{
                            "content": map[string]any{
                                "application/json": map[string]any{
                                    "schema": map[string]any{
                                        "type": "object",
                                        "properties": map[string]any{
                                            "id":   map[string]any{"type": "string", "format": "uuid"},
                                            "name": map[string]any{"type": "string"},
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
    }
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(spec)
})
```

### Node.js / Express

```typescript
app.get('/openapi.json', (_req, res) => {
  res.json({
    openapi: '3.0.3',
    info: { title: 'My Service', version: process.env.APP_VERSION ?? 'dev' },
    paths: {
      '/healthz': {
        get: { summary: 'Health check', responses: { '200': { description: 'OK' } } },
      },
      '/api/v1/orders': {
        post: {
          summary: 'Create order',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['userId', 'items'],
                  properties: {
                    userId: { type: 'string', format: 'uuid' },
                    items: { type: 'array', items: { type: 'string' } },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      orderId: { type: 'string', format: 'uuid' },
                      status:  { type: 'string', enum: ['pending', 'confirmed'] },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
});
```

**The richer your schemas (requestBody, response schemas, required fields, format, enum), the more useful the generated Pact tests will be.** The generator extracts these to produce `like()`, `integer()`, `regex()`, and `eachLike()` matchers automatically.

---

## Generated Pact Tests — What They Look Like

Given a provider spec with a `POST /pets` endpoint:

```typescript
import { PactV3, MatchersV3 } from '@pact-foundation/pact';
import * as path from 'path';

const { like, eachLike, regex, integer, decimal } = MatchersV3;

const provider = new PactV3({
  consumer: 'frontend-app',
  provider: 'pet-store',
  dir: path.resolve(process.cwd(), 'pacts'),
});

describe('frontend-app → pet-store contract', () => {

  it('Create pet', async () => {
    await provider
      .given('pet-store is available')
      .uponReceiving('a request to POST /pets')
      .withRequest({
        method: 'POST',
        path: '/pets',
        headers: { 'Content-Type': 'application/json' },
        body: like({ name: like('string'), tag: like('string') }),
      })
      .willRespondWith({
        status: 201,
        headers: { 'Content-Type': 'application/json' },
        body: like({
          id: regex('550e8400-e29b-41d4-a716-446655440000', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
          name: like('string'),
        }),
      })
      .executeTest(async (mockServer) => {
        const response = await fetch(`${mockServer.url}/pets`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'string', tag: 'string' }),
        });
        const body = await response.json() as Record<string, unknown>;
        expect(response.status).toBe(201);
        expect(body.id).toBeDefined();
        expect(body.name).toBeDefined();
      });
  });

});
```

The test code is a production-ready starting point. You should:
- Replace `like('string')` placeholders with realistic domain values
- Add provider state setup if your provider needs seeded data
- Publish the resulting `./pacts/` directory to your Pact broker

---

## MCP Tool Reference

All tools are callable via `POST /mcp` (JSON-RPC 2.0, `Accept: application/json, text/event-stream`).

### `fetch_service_contract`

Pull `/openapi.json` from a running service and auto-register it as a contract.

```bash
curl -s http://contract-mcp-server.idp.local/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
    "name":"fetch_service_contract",
    "arguments":{"service_name":"hello-service","namespace":"services-dev","port":80}
  }}' | grep '^data:' | sed 's/^data: //'
```

Response includes: `paths[]`, `schemas{}` (per-operation parameters + requestBody + responses + examples), `source`, `version`, `title`.

---

### `auto_discover_contracts`

Scan every service in a namespace and register all that expose `/openapi.json`.

```bash
curl -s http://contract-mcp-server.idp.local/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
    "name":"auto_discover_contracts",
    "arguments":{"namespace":"services-dev","port":80}
  }}' | grep '^data:' | sed 's/^data: //'
```

Response: `{ scanned, discovered, skipped, errors, services: [{serviceName, status, paths}] }`

---

### `register_contract`

Manually push an OpenAPI spec (JSON or YAML string).

```bash
SPEC=$(cat openapi.json | jq -Rs .)
curl -s http://contract-mcp-server.idp.local/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{
    \"name\":\"register_contract\",
    \"arguments\":{\"service_name\":\"my-service\",\"version\":\"2.0.0\",\"openapi_spec\":${SPEC}}
  }}" | grep '^data:' | sed 's/^data: //'
```

Fires the breaking-change webhook automatically if a previous version exists and breaking changes are detected.

---

### `get_contract`

Retrieve a stored contract. Returns the full spec **plus a `schemas` field** with per-operation context (parameters, requestBody, response examples) for AI agent consumption.

```bash
curl -s http://contract-mcp-server.idp.local/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
    "name":"get_contract",
    "arguments":{"service_name":"hello-service"}
  }}' | grep '^data:' | sed 's/^data: //'
```

Response shape:
```json
{
  "serviceName": "hello-service",
  "version": "1.2.0",
  "paths": ["/healthz", "/api/v1/users"],
  "schemas": {
    "/api/v1/users": {
      "post": {
        "summary": "Create user",
        "parameters": [],
        "requestBody": {
          "required": true,
          "contentType": "application/json",
          "properties": ["name", "email"],
          "required_fields": ["name", "email"],
          "example": { "name": "string", "email": "user@example.com" }
        },
        "responses": {
          "201": {
            "contentType": "application/json",
            "properties": ["id", "name"],
            "example": { "id": "550e8400-...", "name": "string" }
          }
        }
      }
    }
  },
  "spec": { ... }
}
```

---

### `list_contracts`

List all registered services and their available versions.

```bash
curl -s http://contract-mcp-server.idp.local/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_contracts","arguments":{}}}' \
  | grep '^data:' | sed 's/^data: //'
```

---

### `generate_contract_tests`

Generate Pact consumer tests from a registered provider spec.

```bash
curl -s http://contract-mcp-server.idp.local/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
    "name":"generate_contract_tests",
    "arguments":{"service_name":"hello-service","consumer_name":"frontend-app"}
  }}' | grep '^data:' | sed 's/^data: //'
```

Returns:
- `pactJson` — Pact v3 interaction JSON with real request/response bodies (drop into `./pacts/`)
- `testCode` — TypeScript using `MatchersV3`: `like()`, `integer()`, `decimal()`, `regex()`, `eachLike()`
- `instructions` — where to save the files and how to run them

---

### `validate_compatibility`

Check if a provider's current spec satisfies all paths expected by a consumer (both must be registered).

```bash
curl -s http://contract-mcp-server.idp.local/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
    "name":"validate_compatibility",
    "arguments":{"provider_name":"hello-service","consumer_name":"frontend-app"}
  }}' | grep '^data:' | sed 's/^data: //'
```

Returns: `compatible: true/false`, `missingPaths`, and a human-readable verdict.

---

### `detect_breaking_changes`

Compare two versions of a service spec. Detects: `path_removed`, `method_removed`, `required_param_added`.

```bash
curl -s http://contract-mcp-server.idp.local/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
    "name":"detect_breaking_changes",
    "arguments":{"service_name":"my-service","from_version":"1.0.0","to_version":"2.0.0"}
  }}' | grep '^data:' | sed 's/^data: //'
```

Returns: `{ breaking: [{type, path, method, detail}], nonBreaking: [...], summary }`.

---

### `get_compatibility_report`

Full consumer/provider compatibility matrix: every registered service checked as a potential consumer.

```bash
curl -s http://contract-mcp-server.idp.local/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
    "name":"get_compatibility_report",
    "arguments":{"service_name":"hello-service"}
  }}' | grep '^data:' | sed 's/^data: //'
```

Returns: `{ totalConsumers, compatible: N, incompatible: N, consumers: [{consumer, compatible, missingPaths}] }`.

---

## REST API Reference

Useful for CI pipelines that don't need the full MCP protocol.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/contracts/:service/:version` | `X-Api-Key` | Register contract (body: raw OpenAPI JSON/YAML) |
| `GET`  | `/api/contracts/:service` | none | Get latest contract (`?version=` for specific) |
| `GET`  | `/api/contracts` | none | List all registered services |
| `GET`  | `/api/compatibility/:provider/:consumer` | none | 200 = compatible, 409 = broken |
| `POST` | `/api/breaking-changes` | none | Body: `{service_name, from_version, to_version}` |

CI example using the REST API:

```bash
# Register the PR spec
curl -sf $CONTRACT_SERVER/api/contracts/$SERVICE_NAME/$NEW_VERSION \
  -H "X-Api-Key: $CONTRACT_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @openapi.json

# Check for breaking changes vs the previous version
RESULT=$(curl -sf $CONTRACT_SERVER/api/breaking-changes \
  -H "Content-Type: application/json" \
  -d "{\"service_name\":\"$SERVICE_NAME\",\"from_version\":\"$PREV_VERSION\",\"to_version\":\"$NEW_VERSION\"}")

echo "$RESULT" | jq -e '.breaking | length == 0' \
  || (echo "Breaking changes detected:" && echo "$RESULT" | jq '.breaking' && exit 1)
```

---

## Claude Desktop / Custom MCP Client Setup

To use the contract testing tools directly from Claude Desktop or any MCP-compatible client:

```json
{
  "mcpServers": {
    "contract-testing": {
      "url": "http://contract-mcp-server.idp.local/mcp",
      "transport": "streamable-http"
    }
  }
}
```

Add this to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS). After restarting Claude Desktop, the 9 tools appear automatically and you can use them in any conversation: *"use register_contract to register this OpenAPI spec for payments-api v2.0.0: ..."*

**Note:** Always set `Accept: application/json, text/event-stream` for raw MCP calls. Without it the StreamableHTTP transport returns 406.

---

## Backstage Templates

### contract-testing-suite

Generates a full Pact test project for a consumer/provider pair.

1. Open **Backstage → Create** → search **"Contract Testing Suite"**
2. Fill in: **Consumer name**, **Provider name**, **Provider base URL**
3. Choose **new-repository** or **add-to-existing**
4. Click **Create**

Generated files:
- `contract/openapi.yaml` — consumer's expected contract (edit to match your actual API calls)
- `tests/<name>.pact.spec.ts` — Pact V3 consumer tests with MatchersV3
- `.github/workflows/contract.yml` — CI: run tests → publish to Pact broker → provider verify
- `catalog-info.yaml` — registers in Backstage catalog

### enable-contract-testing

One-click setup for an existing service:
1. Deploys/wires `contract-mcp-server` if not already running
2. Registers `contract-assistant` KAgent
3. Auto-discovers the service's OpenAPI contract via `fetch_service_contract`
4. Scaffolds a consumer test skeleton
5. Applies ArgoCD Helm hook for automatic re-registration on every sync

---

## ArgoCD Self-Testing Hooks

Any service using `helm/service-template` can opt into automatic contract checking on every ArgoCD sync.

```yaml
# helm-values-local.yaml
contractCheck:
  enabled: true
  mcpServerUrl: "http://contract-mcp-server.services-dev.svc.cluster.local:3003"
```

**PostSync** (after every deploy): calls `fetch_service_contract` + `get_compatibility_report` — registers the running spec and logs consumer compatibility status.

**PreSync** (block breaking deploys):

```yaml
contractCheck:
  enabled: true
  checkBreaking: true
  fromVersion: "1.2.0"   # currently deployed version (set by CI)
  toVersion: "2.0.0"     # version being deployed    (set by CI)
```

Before syncing, a Job calls `detect_breaking_changes`. If any breaking changes are found, the Job exits 1 and ArgoCD blocks the sync.

CI pattern to wire versions into Helm:

```yaml
- name: Pass versions to Helm for PreSync gate
  run: |
    CURRENT=$(kubectl get deploy/$SERVICE -n services -o jsonpath='{.spec.template.spec.containers[0].image}' | cut -d: -f2)
    helm upgrade $SERVICE helm/service-template \
      --set contractCheck.fromVersion=$CURRENT \
      --set contractCheck.toVersion=$NEW_TAG \
      --set contractCheck.checkBreaking=true
```

---

## contract-assistant — Quick Reference

Open http://kagent.idp.local → select **contract-assistant**, or use Backstage AI Assistant.

| Goal | Prompt |
|------|--------|
| Make all services self-describing | *"Discover contracts for all services in services-dev"* |
| Pull one service's spec | *"Fetch the contract for hello-service"* |
| See schemas and examples | *"Get the contract for payments-api"* |
| Generate Pact tests | *"Generate contract tests for hello-service consumer frontend-app"* |
| Check compatibility | *"Is frontend-app compatible with hello-service?"* |
| Detect breaking changes | *"Breaking changes between my-service v1.0.0 and v2.0.0?"* |
| Full compatibility audit | *"Show the compatibility report for hello-service"* |
| List registered services | *"List all registered contracts"* |

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3003` | HTTP listen port |
| `STORAGE_TYPE` | `memory` | `memory` / `postgres` / `dynamodb` |
| `DATABASE_URL` | — | PostgreSQL connection string (required if `STORAGE_TYPE=postgres`) |
| `AWS_REGION` | `us-east-1` | AWS region (required if `STORAGE_TYPE=dynamodb`) |
| `DYNAMO_TABLE` | `contract-registry` | DynamoDB table name |
| `DISCOVERY_MODE` | `kubernetes` | `kubernetes` / `http` / `docker` |
| `K8S_API` | `https://kubernetes.default.svc` | Kubernetes API server URL |
| `K8S_TOKEN` | — | Service account bearer token (for out-of-cluster use) |
| `SERVICES_REGISTRY` | — | `name1=http://url1,name2=http://url2` (http discovery mode) |
| `DOCKER_HOST` | `/var/run/docker.sock` | Docker socket path (docker discovery mode) |
| `DISCOVER_PROBE_TIMEOUT_MS` | `2500` | Timeout per service when probing for `/openapi.json` |
| `DISCOVER_CONCURRENCY` | `10` | Max concurrent probes during `auto_discover_contracts` |
| `HTTP_TIMEOUT_MS` | `8000` | General HTTP call timeout |
| `BREAKING_CHANGE_WEBHOOK_URL` | — | URL to POST breaking-change events (Slack, PD, etc.) |
| `API_KEY` | — | If set, write operations require `X-Api-Key` header |

---

## Storage Backends

| `STORAGE_TYPE` | Persistence | When to use |
|----------------|------------|-------------|
| `memory` | Lost on restart | Local dev, ephemeral CI |
| `postgres` | Persistent | Self-hosted, local Docker Compose |
| `dynamodb` | Persistent, managed | AWS-native deployments |

DynamoDB table setup:
```bash
aws dynamodb create-table \
  --table-name contract-registry \
  --attribute-definitions \
    AttributeName=service_name,AttributeType=S \
    AttributeName=version,AttributeType=S \
  --key-schema \
    AttributeName=service_name,KeyType=HASH \
    AttributeName=version,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST \
  --region us-east-1
```

---

## Breaking Change Webhook Payload

```json
{
  "provider": "payments-api",
  "from_version": "1.0.0",
  "to_version": "2.0.0",
  "breaking_changes": [
    { "type": "path_removed",      "path": "/v1/payments/bulk", "detail": "Path /v1/payments/bulk was removed" },
    { "type": "method_removed",    "path": "/v1/payments",      "method": "DELETE", "detail": "DELETE /v1/payments was removed" },
    { "type": "required_param_added", "path": "/v1/pay",       "method": "POST",   "detail": "Required parameter 'currency' added" }
  ],
  "affected_consumers": [
    { "service": "checkout-service", "missingPaths": ["/v1/payments/bulk"] }
  ],
  "timestamp": "2026-06-16T10:30:00Z"
}
```

Wire to Slack: set `BREAKING_CHANGE_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK`.

---

## Redeploy After a Code Change

```bash
cd services/contract-mcp-server
docker build -t localhost:5003/contract-mcp-server:0.1.0 .
docker push localhost:5003/contract-mcp-server:0.1.0
kubectl rollout restart deployment/contract-mcp-server -n services-dev
```

---

## Troubleshooting

**`fetch_service_contract` returns "No OpenAPI spec found"**  
The service does not expose `/openapi.json`. Add the endpoint and redeploy. The probe checks: `/openapi.json`, `/openapi.yaml`, `/api-docs`, `/swagger.json`.

**`auto_discover_contracts` shows all services as `no_spec`**  
Services do not expose `/openapi.json`, or the port is wrong. Most K8s Services listen on port 80. Try `"port": 80`. Check with: `curl http://<service>.<namespace>.svc.cluster.local/openapi.json`.

**`detect_breaking_changes` says "version not found"**  
The version must be registered with `register_contract` before you can diff it. Register the new version in CI before deploying.

**Generated tests compile but all assertions are trivial**  
Your OpenAPI spec has no `requestBody` or response `schema` fields — only path/method definitions. Enrich your spec with schemas, `required` fields, and `format` hints (see "Making a Service Self-Describing" above). The generator extracts these to build matchers.

**KAgent `contract-assistant` shows READY=False**
```bash
kubectl rollout restart deployment/kagent-controller -n kagent
kubectl get agents -n kagent contract-assistant
```

**MCP call returns empty or no `data:` lines**  
Ensure `Accept: application/json, text/event-stream` is set. Without it, the StreamableHTTP transport may return 406.

**`generate_contract_tests` returns "provider not found"**  
The provider must be registered before generating tests. Call `fetch_service_contract` or `register_contract` for the provider first, then generate.

---

**`can-i-deploy` returns 404**  
The service is not registered in the contract registry. Register it first: run `fetch_service_contract` (AI Assistant: *"Register the contract for `<service>`"*) or POST directly to `/api/contracts/<service>/<version>`.

**Breaking changes not detected between versions**  
Both registered versions must have different content. If you registered the same spec twice under different version strings, the diff will be empty. Always register the new (changed) spec before calling `detect_breaking_changes`.

**ArgoCD PreSync hook fails immediately with "fromVersion not set"**  
The PreSync hook requires `contractCheck.fromVersion` and `contractCheck.toVersion` to be passed via Helm values in your CI pipeline. Add `--set contractCheck.fromVersion=<old-version> --set contractCheck.toVersion=<new-version>` to your `helm upgrade` command.

**Audit log is empty after a pod restart**  
The audit log is stored in-memory (circular buffer, 500 events). It is lost when the pod restarts. For a persistent audit trail, switch to `STORAGE_TYPE=postgres` — the audit events will then survive restarts.

**Template not visible in Backstage Create page**  
The contract templates may be commented out in `backstage/catalog/all-templates.yaml`. Uncomment the `contract-testing-suite` and `enable-contract-testing` entries, then restart Backstage (`docker compose restart backstage` for local, or sync the ArgoCD app in-cluster).

**`contract-assistant` not responding in AI Assistant**  
The KAgent agent may not be deployed. Check: `kubectl get agents -n kagent contract-assistant`. If it's missing, run `scripts/bootstrap-ai.sh`. If it exists but shows `READY=False`, restart the controller: `kubectl rollout restart deployment/kagent-controller -n kagent`.

**`auto_discover_contracts` returns 0 services**  
In local/Docker mode, set `DISCOVERY_MODE=http` and `SERVICES_REGISTRY=payments-api=http://payments-api:8000,hello-service=http://hello-service:8080`. The default `kubernetes` mode requires in-cluster API access. In standalone Docker Compose, use the `http` mode.

---

## Common Pitfalls

- **Don't call `/mcp` directly for scripts** — the REST API at `/api` is easier to use from `curl` / CI pipelines. `/mcp` is for MCP-native clients (Claude Desktop, KAgent).
- **Don't use `STORAGE_TYPE=memory` in production** — contracts are lost on every restart. Use `postgres` or `dynamodb`.
- **Don't skip `fetch_service_contract` before `generate_contract_tests`** — the provider must be registered first.
- **Don't omit `required` fields and response schemas from your OpenAPI spec** — the test generator uses these to build meaningful matchers. Without them, generated tests only check HTTP status codes.
