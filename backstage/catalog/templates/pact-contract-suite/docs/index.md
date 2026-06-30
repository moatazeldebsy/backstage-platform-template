# Pact Contract Test Suite

Scaffold a Pact V3 consumer-driven contract test suite with PactFlow broker publishing. Use this template when your team wants direct control over Pact file management and publishing to an external PactFlow instance, without the IDP MCP registry in the middle.

> **New projects**: Consider [Contract Testing Suite (MCP-Powered)](../../contract-testing-suite/docs/index.md) instead — it adds AI-assisted compatibility checks, auto-discovery, and deploy-time gating on top of standard Pact.

---

## What This Template Does

| Step | Output |
|------|--------|
| Generates consumer contract | `contract/openapi.yaml` — your consumer's expected API shape |
| Scaffolds Pact V3 tests | `tests/<name>.pact.spec.ts` — MatchersV3 matchers (like, regex, integer) |
| Wires CI pipeline | `.github/workflows/contract.yml` — test → publish to PactFlow → verify → can-i-deploy |
| Registers in Backstage | `catalog-info.yaml` — `test-suite` component linked to your service |

---

## Prerequisites

- **PactFlow account**: Set `PACT_BROKER_TOKEN` in your GitHub Actions secrets. The default broker URL is `https://moatazeldebsy.pactflow.io`.
- **Provider is running**: The Pact provider verification step calls the live provider. The provider URL must be reachable from CI.
- **GitHub write access**: The scaffolder creates a new repo or opens a PR against an existing one.

---

## Parameters

| Parameter | Required | Description | Example |
|-----------|----------|-------------|---------|
| `name` | Yes | Suite name (lowercase, hyphens only) | `checkout-payments-pact` |
| `description` | Yes | Short description | `Checkout service contract for payments-api` |
| `owner` | Yes | Backstage team | `checkout-team` |
| `targetService` | No | Provider (Backstage catalog picker) | `payments-api` |
| `deploymentMode` | Yes | `new-repository` or `add-to-existing` | `new-repository` |
| `consumerName` | Yes | Consumer service name | `checkout-service` |
| `providerName` | Yes | Provider service name | `payments-api` |
| `providerBaseUrl` | Yes | Provider URL for verification | `http://payments-api.services-dev.svc.cluster.local` |
| `pactBrokerUrl` | No | PactFlow broker URL | `https://moatazeldebsy.pactflow.io` |

---

## Generated File Structure

**`new-repository` mode:**
```
<name>/
├── contract/
│   └── openapi.yaml            # Consumer-driven contract (edit me)
├── tests/
│   └── <name>.pact.spec.ts     # Pact V3 consumer tests
├── pacts/                      # Generated .pact files (gitignored)
├── .github/workflows/
│   └── contract.yml            # CI: test → publish → verify → can-i-deploy
├── catalog-info.yaml
└── package.json
```

**`add-to-existing` mode** (opens PR):
```
.github/workflows/
└── <name>-contract.yml
test-suites/<name>/
├── contract/openapi.yaml
└── tests/<name>.pact.spec.ts
```

---

## CI Pipeline Stages

1. **Consumer tests** — runs Pact tests locally, writes `.pact` file to `pacts/`
2. **Publish pacts** — uploads `.pact` file to PactFlow with version tag
3. **Provider verify** — provider team runs `pact:verify` against the published pact
4. **can-i-deploy** — calls PactFlow's `can-i-deploy` CLI to check if it's safe to deploy the consumer

---

## Next Steps After Scaffolding

1. **Set `PACT_BROKER_TOKEN`** in GitHub Actions secrets for your new repo.
2. **Edit `contract/openapi.yaml`** — trim it to only the paths and fields your consumer actually uses.
3. **Run tests locally**: `npm install && npm test` — generates `pacts/<consumer>-<provider>.json`.
4. **Check PactFlow** at `https://moatazeldebsy.pactflow.io` — your pact should appear after the first CI run.
5. **Coordinate provider verification** — the provider team must add a Pact verification job to their CI to verify your pact.

---

## Difference vs. MCP-Powered Template

| Feature | Pact Contract Suite | Contract Testing Suite (MCP) |
|---------|--------------------|-----------------------------|
| Pact V3 consumer tests | Yes | Yes |
| PactFlow publishing | Yes | Optional |
| IDP contract registry | No | Yes |
| AI-assisted queries | No | Yes (contract-assistant) |
| Auto-discovery | No | Yes |
| ArgoCD deploy gate | No | Yes |
| `can-i-deploy` source | PactFlow API | IDP registry |

---

## Further Reading

- [Contract Testing Guide](../../../../docs/contract-testing.md) — full architecture, MCP tools, and REST API reference
- [MCP-Powered Template](../../contract-testing-suite/docs/index.md) — adds AI, auto-discovery, and ArgoCD gates on top
