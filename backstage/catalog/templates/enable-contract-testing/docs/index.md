# Enable Contract Testing (MCP-Powered)

One-click setup for self-describing, self-testing APIs on the IDP. Run this template against any existing service to automatically deploy the contract infrastructure, register the service's live OpenAPI spec, and optionally scaffold a consumer test suite — all without writing a single Pact file.

---

## What This Template Does

| Step | What Happens |
|------|-------------|
| Verifies prerequisites | Checks that `contract-mcp-server` is reachable |
| Registers the provider contract | Fetches `GET /openapi.json` from the provider and registers it in the IDP contract registry |
| Patches Helm values | Adds `contractCheck.enabled: true` to the service's `helm-values-*.yaml` |
| Wires ArgoCD hooks | Adds a PostSync hook that re-registers the contract after every deploy |
| (Optional) Scaffolds consumer tests | Creates a `contract-testing-suite` project for a named consumer |
| (Optional) Wires PreSync breaking-change gate | Blocks ArgoCD deploys if a breaking change is detected |

---

## Prerequisites

- **Service exposes `/openapi.json`**: The provider must serve its OpenAPI spec at `GET /openapi.json` (or `/openapi.yaml`). FastAPI and most modern frameworks do this automatically. See [Making a Service Self-Describing](../../../../docs/contract-testing.md#making-a-service-self-describing) for Go, Node.js, and Python examples.
- **Service deployed in Kubernetes**: The template fetches the spec from the running pod. Local-only services won't work.
- **Backstage scaffolder write access**: Needs GitHub write access to create/update the service repo.
- **`contract-mcp-server` reachable**: Confirm at `http://contract-mcp-server.idp.local/healthz`. If it returns a non-200, run `scripts/bootstrap-ai.sh` first.

---

## Parameters

| Parameter | Required | Description | Example |
|-----------|----------|-------------|---------|
| `targetService` | No | Provider service (Backstage catalog picker) | `payments-api` |
| `providerName` | Yes | Kubernetes service name of the provider | `payments-api` |
| `consumerName` | Yes | Name of the service that will consume the provider | `checkout-service` |
| `targetNamespace` | No | Kubernetes namespace where provider runs | `services-dev` (default) |
| `targetPort` | No | Kubernetes Service port | `80` (default) |
| `contractMcpServerUrl` | No | IDP contract registry URL | `http://contract-mcp-server.idp.local` |
| `scaffoldConsumerTests` | No | Also scaffold a consumer test project | `true` / `false` |
| `enableBreakingChangeGate` | No | Wire ArgoCD PreSync hook to block breaking changes | `false` (default) |
| `repoUrl` | Yes | GitHub repo for the provider service | `github.com?repo=payments-api&owner=moatazeldebsy` |

---

## What Gets Added to Your Service Repo

```
helm-values-local.yaml (patched):
  contractCheck:
    enabled: true
    mcpServerUrl: "http://contract-mcp-server.services-dev.svc.cluster.local:3003"
    checkBreaking: false  # set to true via --enableBreakingChangeGate

# If ArgoCD hooks enabled, helm/service-template applies:
# - PostSync: re-registers /openapi.json after every deploy
# - PreSync (optional): blocks sync if breaking changes detected
```

---

## After Scaffolding

1. **Verify contract registered** — open the AI Assistant (`/ai-assistant`) → contract-assistant → ask: *"List all registered contracts"*. Your service should appear.
2. **Check compatibility** — ask: *"Show me the compatibility report for `<provider>`"*
3. **Try the deploy gate** — ask: *"Can I deploy `<provider>` v1.0.0?"* — it will return `safe: true` if no consumers are broken.
4. **Break something intentionally** — remove a field from your OpenAPI spec, push, and watch ArgoCD block the sync (if PreSync gate is enabled).

---

## Demo Flow (3 minutes)

This template is the recommended starting point for live demos:

1. Backstage `/create` → **Enable Contract Testing** → fill in `payments-api` as provider, `checkout-service` as consumer
2. Watch the scaffolder register the contract automatically
3. Open AI Assistant → *"Can I deploy payments-api v1.0.0?"* → `safe: true`
4. Remove a field from the OpenAPI spec → push → show the breaking change detected

---

## Further Reading

- [Contract Testing Guide](../../../../docs/contract-testing.md) — full architecture, 13 MCP tools, CI flows, and storage backends
- [Contract Testing Suite template](../../contract-testing-suite/docs/index.md) — scaffold the consumer test project
