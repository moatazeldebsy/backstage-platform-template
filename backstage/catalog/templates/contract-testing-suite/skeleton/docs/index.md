# ${{ values.name }}

${{ values.description }}

## Overview

This is a self-describing, MCP-powered contract test suite for the `${{ values.consumerName }}` → `${{ values.providerName }}` API relationship.

| Field | Value |
|-------|-------|
| Consumer | `${{ values.consumerName }}` |
| Provider | `${{ values.providerName }}` |
| Owner | `${{ values.owner }}` |
| Provider URL | `${{ values.providerBaseUrl }}` |

## What's included

- **`contract/openapi.yaml`** — OpenAPI 3.x spec describing the subset of the provider API this consumer depends on. This is the "consumer contract" — it gets registered with the IDP contract registry so AI agents can check compatibility.
- **`tests/${{ values.name }}.pact.spec.ts`** — Pact V3 consumer tests that run against a mock server derived from the contract.
- **`.github/workflows/contract.yml`** — CI workflow that runs tests, registers the contract spec, and optionally publishes to a Pact broker.

## Running tests locally

```bash
npm install
npm test
```

## Updating the contract

1. Edit `contract/openapi.yaml` to reflect your consumer's actual API expectations
2. Update `tests/${{ values.name }}.pact.spec.ts` to match the new interactions
3. Run `npm test` to verify
4. Push to `main` — CI will auto-register the updated spec with the contract registry

## AI-assisted contract management

Use the **contract-assistant** agent in the IDP (Backstage → AI Assistant, or KAgent UI) to:

- Generate tests from an OpenAPI spec: *"Generate contract tests for ${{ values.providerName }} consumer ${{ values.consumerName }}"*
- Check compatibility: *"Is ${{ values.consumerName }} compatible with the latest ${{ values.providerName }} spec?"*
- Detect breaking changes: *"Are there breaking changes between ${{ values.providerName }} v1.0.0 and v2.0.0?"*
- Get the full platform compatibility report: *"Show the compatibility report for ${{ values.providerName }}"*

## Registering the contract manually

```bash
SPEC=$(cat contract/openapi.yaml | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))")
curl -X POST ${{ values.contractMcpServerUrl }}/mcp \
  -H 'Content-Type: application/json' \
  -d "{\"method\":\"tools/call\",\"params\":{\"name\":\"register_contract\",\"arguments\":{\"service_name\":\"${{ values.consumerName }}\",\"version\":\"1.0.0\",\"openapi_spec\":${SPEC}}}}"
```
