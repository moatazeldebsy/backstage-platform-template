# Contract Testing Suite (MCP-Powered)

Scaffold a self-describing, self-testing API contract suite. This template generates an OpenAPI consumer contract, Pact V3 consumer tests, and a CI workflow that auto-registers the spec with the IDP contract registry (`contract-mcp-server`) for AI-assisted compatibility checks and deploy-time gating.

---

## What This Template Does

| Step | Output |
|------|--------|
| Generates consumer contract | `contract/openapi.yaml` — edit to describe what your service expects from the provider |
| Scaffolds Pact V3 tests | `tests/<name>.pact.spec.ts` — runs locally and in CI with realistic schema matchers |
| Wires CI pipeline | `.github/workflows/contract.yml` — runs tests → registers spec → publishes to broker → verifies provider → deploy gate |
| Registers in Backstage | `catalog-info.yaml` — creates a `test-suite` component linked to your service |

---

## Prerequisites

- **Provider registered**: The provider service must expose `GET /openapi.json` and be reachable from the cluster. If not, run the **Enable Contract Testing** template on the provider first.
- **contract-mcp-server running**: Confirm at `http://contract-mcp-server.idp.local/healthz`. If not, run `scripts/bootstrap-ai.sh`.
- **GitHub repository access**: The template creates a new repo (or opens a PR). The scaffolder requires write access to `github.com/moatazeldebsy`.
- **Pact broker (optional)**: If publishing to PactFlow, set `PACT_BROKER_TOKEN` in GitHub Actions secrets.

---

## Parameters

| Parameter | Required | Description | Example |
|-----------|----------|-------------|---------|
| `name` | Yes | Unique name for this suite (lowercase, hyphens) | `checkout-payments-contract` |
| `description` | Yes | Short description | `Checkout service → payments-api contract` |
| `owner` | Yes | Backstage team owner | `checkout-team` |
| `targetService` | No | Provider service (from Backstage catalog) | `payments-api` |
| `deploymentMode` | Yes | `new-repository` or `add-to-existing` | `new-repository` |
| `consumerName` | Yes | Consumer service name | `checkout-service` |
| `providerName` | Yes | Provider service name | `payments-api` |
| `providerBaseUrl` | Yes | Provider base URL for Pact tests | `http://payments-api.services-dev.svc.cluster.local` |
| `pactBrokerUrl` | No | PactFlow broker URL | `https://moatazeldebsy.pactflow.io` |
| `contractMcpServerUrl` | No | IDP contract registry | `http://contract-mcp-server.idp.local` |

---

## Generated File Structure

**`new-repository` mode:**
```
<name>/
├── contract/
│   └── openapi.yaml            # Consumer-driven OpenAPI contract (edit me)
├── tests/
│   └── <name>.pact.spec.ts     # Pact V3 consumer tests with MatchersV3
├── .github/workflows/
│   └── contract.yml            # Full CI pipeline
├── catalog-info.yaml           # Backstage entity (kind: Component, type: test-suite)
└── package.json                # @pact-foundation/pact, jest, ts-jest
```

**`add-to-existing` mode** (opens PR against your service repo):
```
.github/workflows/
└── <name>-contract.yml         # Contract CI workflow
test-suites/<name>/
├── contract/openapi.yaml
├── tests/<name>.pact.spec.ts
└── catalog-info.yaml
```

---

## CI Pipeline Stages

The generated `.github/workflows/contract.yml` runs these stages on every push:

1. **Consumer tests** — `npm test` runs Pact V3 tests, generates `.pact` file
2. **Register with IDP** — POST spec to `contract-mcp-server` at `/api/contracts/<name>/<version>`
3. **Publish to broker** — publishes `.pact` file to PactFlow (if `PACT_BROKER_URL` set)
4. **Provider verify** — runs Pact provider verification against the live provider
5. **Deploy gate** — calls `GET /api/can-i-deploy/<name>/<version>` — fails CI if unsafe

---

## Next Steps After Scaffolding

1. **Edit the consumer contract** — open `contract/openapi.yaml` and describe the exact paths and response fields your service depends on (not the full provider spec — only what you consume).
2. **Run tests locally** — `npm install && npm test` — Pact will generate a `.pact` file in `pacts/`.
3. **Add `PACT_BROKER_TOKEN`** to GitHub Actions secrets if you want PactFlow publishing.
4. **Open the Backstage catalog entry** — the scaffolder registers the suite as a component linked to your provider.
5. **Ask the AI assistant** — open `/ai-assistant` → `contract-assistant` and ask: *"Is `<consumer>` compatible with `<provider>` v1.0.0?"*

---

## Further Reading

- [Contract Testing Guide](../../../../docs/contract-testing.md) — full architecture, MCP tools, CI flows, and REST API reference
- [Self-Describing APIs Guide](../../../../docs/self-describing-apis.md) — how to make services expose their own contracts
- [Enable Contract Testing template](../../enable-contract-testing/docs/index.md) — one-click onboarding for providers
