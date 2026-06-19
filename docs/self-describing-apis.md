# Self-Describing, Self-Testing APIs

A team-facing guide to the contract testing capability built into this IDP. Every service
scaffolded here automatically exposes its OpenAPI spec, registers it in a central contract
registry, and gets a CI pipeline that catches breaking changes before they reach production.

---

## What This Feature Does

Three things happen automatically when you build a service on this platform:

1. **Self-describing** — your service exposes `GET /openapi.json` at runtime, always returning
   its live spec. No static file to maintain or forget to update.

2. **Self-registering** — on every deployment, an ArgoCD PostSync hook fetches that spec and
   registers it in the `contract-mcp-server`. The registry always reflects what is actually
   running.

3. **Self-testing** — consumer teams scaffold a test suite once via Backstage. From then on,
   their CI pipeline generates and runs Pact V3 consumer tests and blocks merges if a provider
   change breaks compatibility.

An AI agent — `contract-assistant` — wraps the entire registry as natural-language workflows, so
teams can discover, generate, and verify contracts by chatting rather than writing scripts.

---

## The Three Layers

| Layer | What it does | When it runs |
|-------|-------------|--------------|
| Self-describing | Service exposes `GET /openapi.json` | Always — baked into scaffold |
| Self-registering | ArgoCD PostSync hook auto-registers after deploy | On every `helm upgrade` |
| Self-testing | CI runs Pact consumer tests, blocks PR on breaking changes | On every PR and push |

---

## Does CI Require a Pact Broker?

**No. The Pact broker is completely optional.**

The scaffolded CI workflow checks for `PACT_BROKER_TOKEN` and exits cleanly when it is not set.
Consumer tests always run — they use a Pact V3 in-process mock server that requires no external
infrastructure. The `contract-mcp-server` is the contract registry; it stores API specs
internally and handles compatibility checking without a broker.

Three modes are supported:

| Mode | Setup required | What you get |
|------|---------------|--------------|
| **Local only** | Nothing | `npm test` runs Pact V3 mock in-process. Works on any laptop. |
| **IDP-only** (recommended) | `contract-mcp-server` deployed | Contracts registered centrally. AI assistant, compatibility checks, breaking-change detection — all via the registry. No broker. |
| **With PactFlow broker** | Add `PACT_BROKER_TOKEN` GitHub secret | Full consumer/provider verification across team boundaries, version tagging, PactFlow dashboard. |

For the demo and for most internal service pairs, the IDP-only mode is sufficient.

---

## What Lands in Your GitHub Repo

When you scaffold via **Enable Contract Testing** or **Contract Testing Suite** in Backstage,
the following files are committed to the new repository:

```
.github/
  workflows/
    contract.yml          # GitHub Actions: run tests → register → (optionally) publish
contract/
  openapi.yaml            # Your consumer-side OpenAPI contract spec (edit to match what you consume)
tests/
  <service-name>.pact.spec.ts  # Pre-wired Pact V3 consumer test — runs immediately
docs/
  index.md                # TechDocs page for this test suite
catalog-info.yaml         # Backstage entity (kind: Component, type: test-suite)
package.json              # Dependencies: @pact-foundation/pact, jest, ts-jest
README.md                 # Quick start, links to Backstage catalog, AI assistant prompts
```

If you selected **Enable ArgoCD Hooks** during scaffolding:

```
helm-patches/
  contract-check.yaml     # PostSync + PreSync hook values — merge into your service's Helm values
```

The developer clones the repo, runs `npm test`, and contract testing is immediately working.
No additional configuration required.

### The Scaffolded Pact Test

```typescript
// tests/payments-api.pact.spec.ts — committed to your repo on scaffold
import { PactV3, MatchersV3 } from '@pact-foundation/pact';

const { like } = MatchersV3;

const provider = new PactV3({
  consumer: 'frontend-app',
  provider: 'payments-api',
  dir: path.resolve(process.cwd(), 'pacts'),
});

describe('frontend-app → payments-api contract', () => {
  it('provider health check returns ok', async () => {
    await provider
      .given('payments-api is available')
      .uponReceiving('a health check request')
      .withRequest({ method: 'GET', path: '/healthz' })
      .willRespondWith({
        status: 200,
        headers: { 'Content-Type': like('application/json') },
        body: like({ status: 'ok' }),
      })
      .executeTest(async (mockServer) => {
        const response = await fetch(`${mockServer.url}/healthz`);
        expect(response.status).toBe(200);
      });
  });

  // Add more interactions — or ask the AI assistant to generate them:
  // "Generate contract tests for payments-api consumer frontend-app"
});
```

`like()` is a loose matcher — it validates shape and type, not exact values. The AI assistant
generates realistic matchers (regex, integer, eachLike, etc.) based on the provider's OpenAPI
schema when you use `generate_contract_tests`.

---

## CI Workflow — Step by Step

The scaffolded `.github/workflows/contract.yml` runs on every PR and push to `main`:

```
┌─────────────────────────────────────────────────┐
│  Job: consumer-tests (runs on every PR + push)  │
│                                                 │
│  1. npm ci                                      │
│  2. npm test  ◄── Pact V3 mock server, no deps  │
│  3. Register spec in contract-mcp-server         │
│     (skips if CONTRACT_MCP_SERVER_URL not set)  │
│  4. Publish pact to broker  [main only]          │
│     (skips if PACT_BROKER_TOKEN not set)        │
└─────────────────────────────────────────────────┘
         │
         │ (main branch only, after consumer job)
         ▼
┌───────────────────────────────────────────────────────┐
│  Job: provider-verify                                 │
│                                                       │
│  Fetches pacts from broker, verifies provider impl    │
│  Skips cleanly if PACT_BROKER_TOKEN not set           │
└───────────────────────────────────────────────────────┘
```

**Step 3 detail** — the CI registers the consumer's OpenAPI spec with the MCP server on every
main-branch push. This keeps the registry in sync even without ArgoCD hooks:

```bash
curl -sf -X POST "${CONTRACT_MCP_SERVER_URL}/mcp" \
  -H 'Content-Type: application/json' \
  -d '{"method":"tools/call","params":{"name":"register_contract","arguments":{
    "service_name":"frontend-app",
    "version":"a3f9c12",
    "openapi_spec": "..."
  }}}'
```

---

## The Full Demo Flow

### Setup (platform team, one-time)

```bash
# Deploy contract-mcp-server
helm upgrade --install contract-mcp-server helm/service-template \
  --namespace services-dev \
  --values services/contract-mcp-server/helm-values-local.yaml

# Register it as an MCP tool server and deploy the AI agent
kubectl apply -f kubernetes/kagent/contract-toolserver.yaml
kubectl apply -f kubernetes/kagent/contract-agent.yaml
```

### Step 1 — Scaffold the Provider

1. Open `http://backstage.idp.local/create`
2. Choose **Node.js Service**, **Go Service**, or **Python Service**
3. Name it `payments-api` → click **Create**

The scaffolded service includes `GET /openapi.json` out of the box.

### Step 2 — Scaffold the Consumer

1. Choose any service template
2. Name it `frontend-app` → click **Create**

### Step 3 — Enable Contract Testing

1. Search **"Enable Contract Testing"** in the Backstage scaffolder
2. Select `payments-api` as the provider (Catalog entity picker)
3. Enter `frontend-app` as the consumer
4. Click **Create** — Backstage auto-discovers the provider's spec, registers it, and creates
   the test repo with all files pre-wired

### Step 4 — AI Assistant: Discover All Services

Open `http://backstage.idp.local/ai-assistant`, select **contract-assistant**, then:

> *"Auto-discover contracts for all services in the services-dev namespace"*

The agent calls `auto_discover_contracts`, scans every running pod for a `/openapi.json`
endpoint, and registers them all. No manual registration needed for teams that haven't onboarded
yet.

### Step 5 — AI Assistant: Generate Tests

> *"Generate Pact contract tests for payments-api as the provider and frontend-app as the consumer"*

The agent calls `generate_contract_tests`, reads the registered OpenAPI spec, and returns a
complete TypeScript test file with realistic matchers. Paste it into your test repo.

### Step 6 — AI Assistant: Check for Breaking Changes

> *"Are there breaking changes between payments-api v1.0.0 and v2.0.0?"*

The agent calls `detect_breaking_changes` and returns a structured diff:
- Which endpoints were removed or renamed (breaking)
- Which request fields became required (breaking)
- Which response fields were added (non-breaking)

### Step 7 — CI Blocks the Deployment

If the provider team pushes a breaking change, the ArgoCD PreSync hook (when
`contractCheck.checkBreaking: true`) calls `detect_breaking_changes` before applying the new
Helm release and exits 1 — blocking the deployment until the consumer is updated.

---

## Automated vs. Manual

| Action | Automated path | Manual fallback (AI assistant) |
|--------|---------------|-------------------------------|
| Register API contract | ArgoCD PostSync hook on every deploy | *"Register contract for payments-api v1.0.0"* |
| Discover all services | `auto_discover_contracts` on deploy | *"Auto-discover contracts in services-dev"* |
| Generate Pact tests | CI triggers on PR | *"Generate tests for payments-api consumer frontend-app"* |
| Detect breaking changes | CI PreSync gate | *"Are there breaking changes between v1 and v2?"* |
| Block deployment | Helm PreSync hook exits 1 | Review compatibility report manually |
| Validate consumer compatibility | CI on every push | *"Is frontend-app compatible with payments-api?"* |
| Full compatibility matrix | On-demand via REST API | *"Show the compatibility report for payments-api"* |

---

## AI Assistant Prompt Reference

Copy-paste these into `http://backstage.idp.local/ai-assistant` → `contract-assistant`:

```
Auto-discover contracts for all services in the services-dev namespace

Register contract for payments-api version 1.0.0 with spec from http://payments-api.services-dev.svc.cluster.local/openapi.json

Generate Pact contract tests for payments-api as the provider and frontend-app as the consumer

Is frontend-app compatible with the latest version of payments-api?

Are there breaking changes between payments-api v1.0.0 and v2.0.0?

Show the compatibility report for payments-api

List all registered contracts
```

---

## For Platform Teams — Enablement Checklist

Use this checklist when enabling this feature on a new cluster:

- [ ] `contract-mcp-server` deployed via Helm in `services-dev` namespace
- [ ] `kubernetes/kagent/contract-toolserver.yaml` applied (registers MCP server with KAgent)
- [ ] `kubernetes/kagent/contract-agent.yaml` applied (creates `contract-assistant` agent)
- [ ] All service templates have `contractCheck.enabled: true` in `helm-values-local.yaml`
- [ ] Backstage ingress has `proxy-read-timeout: "300"` and `proxy-send-timeout: "300"`
- [ ] KAgent ingress has `proxy-read-timeout: "300"` and `proxy-send-timeout: "300"`
- [ ] (Optional) `PACT_BROKER_TOKEN` set as GitHub org secret for broker publishing
- [ ] (Optional) `CONTRACT_MCP_SERVER_URL` set as GitHub org secret for CI registration

Verify end-to-end:

```bash
# Registry is up
curl http://contract-mcp-server.idp.local/healthz
# → {"status":"ok"}

# At least one contract registered (after Step 3 or auto-discover)
curl http://contract-mcp-server.idp.local/api/contracts
# → [{"service_name":"payments-api","version":"1.0.0",...}]

# Compatibility check between two services
curl http://contract-mcp-server.idp.local/api/compatibility/payments-api/frontend-app
# → {"compatible":true,...}
```

---

## How It Relates to the Reference Docs

This document covers the team-facing adoption path. For deeper technical detail:

- **Full MCP tool reference + REST API** → [`docs/contract-testing.md`](contract-testing.md)
- **Standalone setup (no Backstage)** → [`docs/contract-testing-standalone.md`](contract-testing-standalone.md)
- **Scaffolder templates** → `backstage/catalog/templates/enable-contract-testing/`
- **Contract registry source** → `services/contract-mcp-server/src/index.ts`
- **ArgoCD hook job** → `helm/service-template/templates/contract-hook-job.yaml`
