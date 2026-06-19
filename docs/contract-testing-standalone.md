# Contract Testing with MCP

Standalone contract registry — no Backstage or IDP required.

## What it does

The `contract-mcp-server` is a central registry that:

1. **Stores OpenAPI specs** for every service that registers (persistent across restarts with PostgreSQL or DynamoDB)
2. **Detects breaking changes** between versions (removed paths, removed methods, new required params)
3. **Validates consumer compatibility** — a consumer declares which paths it needs; the server verifies the provider still exposes them
4. **Fires a webhook** when a provider pushes a breaking version

## Architecture

```
Provider CI (any team)      Consumer CI (any team)
       │                            │
       ▼                            ▼
POST /api/contracts/:svc/:v    POST /api/contracts/:svc/:v
       │                            │
       └──────────┬─────────────────┘
                  ▼
       contract-mcp-server :3003
       ┌──────────────────────────────┐
       │  9 MCP tools                 │
       │  REST shim (/api/...)        │  → PostgreSQL (persistent)
       │  Breaking-change webhook     │
       └──────────────────────────────┘
```

## Local Quickstart (Docker Compose, no K8s needed)

**Prerequisites:** Docker

```bash
cd services/contract-mcp-server

# 1. Copy and fill in env vars
cp .env.example .env

# 2. Start server + PostgreSQL
docker compose -f docker-compose.standalone.yml up -d

# 3. Verify
curl http://localhost:3003/healthz
# {"status":"ok","version":"2.0.0","storageType":"postgres","discoveryMode":"http"}

# 4. Register a contract
curl -X POST http://localhost:3003/api/contracts/payments-api/1.0.0 \
  -H "Content-Type: application/json" \
  --data-binary @path/to/openapi.json
```

## Multi-Team Workflow

### Provider team (API owner)

Add to your CI pipeline on every PR that touches the API spec:

```yaml
# .github/workflows/contract-publish.yml
- name: Register contract
  env:
    CONTRACT_TOKEN: ${{ secrets.CONTRACT_TOKEN }}
  run: |
    curl -sX POST $CONTRACT_SERVER/api/contracts/$SERVICE_NAME/${{ github.sha }} \
      -H "X-Api-Key: $CONTRACT_TOKEN" \
      -H "Content-Type: application/json" \
      --data-binary @openapi.json
```

The server automatically detects breaking changes vs the previous version and fires the webhook if `BREAKING_CHANGE_WEBHOOK_URL` is configured.

### Consumer team (API caller)

Register your service's own OpenAPI spec (the paths your service exposes, which implicitly declares the upstream paths you depend on) — or use the `generate_contract_tests` MCP tool to produce a Pact file:

```bash
# Generate Pact consumer tests from provider spec
curl -X POST http://localhost:3003/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"generate_contract_tests","arguments":{"service_name":"payments-api","consumer_name":"checkout-service"}}}'
```

Add a compatibility gate to your CI:

```bash
# Fails (HTTP 409) if payments-api is missing paths checkout-service needs
curl -sf $CONTRACT_SERVER/api/compatibility/payments-api/checkout-service \
  || (echo "Compatibility broken" && exit 1)
```

### Reusable CI workflow

Copy `.github/workflows/contract-check.yml` into your service repo. It:
- Registers your spec on every PR
- Detects breaking changes vs the last registered version
- Posts a summary as a PR comment
- Fails the PR if breaking changes are detected

Required repository secrets: `CONTRACT_TOKEN`  
Required repository variables: `CONTRACT_SERVER_URL`, `SERVICE_NAME`

## REST API Reference

All write operations require `X-Api-Key: <API_KEY>` header if `API_KEY` is set on the server. Read operations are always public.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/contracts/:service/:version` | Register contract (body: raw OpenAPI JSON/YAML) |
| `GET` | `/api/contracts/:service` | Get latest contract (`?version=` for specific) |
| `GET` | `/api/contracts` | List all registered services |
| `GET` | `/api/compatibility/:provider/:consumer` | Check compatibility (200=ok, 409=broken) |
| `POST` | `/api/breaking-changes` | Detect breaking changes (body: `{service_name, from_version, to_version}`) |

## MCP Tools Reference

The server exposes 9 tools at `POST /mcp` (JSON-RPC 2.0 + StreamableHTTP).

| Tool | Description |
|------|-------------|
| `register_contract` | Register/update OpenAPI spec; auto-detects breaking changes and fires webhook |
| `get_contract` | Retrieve registered spec + `schemas` field (per-operation parameters, requestBody, response examples) |
| `list_contracts` | List all services and versions |
| `generate_contract_tests` | Generate Pact consumer tests with real schema matchers (`like`, `integer`, `regex`, `eachLike`) |
| `validate_compatibility` | Check provider satisfies consumer's required paths |
| `detect_breaking_changes` | Compare two spec versions |
| `get_compatibility_report` | Full compatibility matrix for a provider |
| `fetch_service_contract` | Pull spec from running service, register it, return `schemas` context |
| `auto_discover_contracts` | Scan all services (K8s/Docker/registry) and register specs |

**`generate_contract_tests` output:** produces TypeScript using `@pact-foundation/pact` MatchersV3. Request bodies are populated from OpenAPI `requestBody` schemas. Response bodies use `like()`, `integer()`, `decimal()`, `regex()`, and `eachLike()` matchers derived from the provider's response schemas. The more complete your OpenAPI spec (schemas, required fields, format hints), the more realistic the generated tests.

**`get_contract` and `fetch_service_contract` response:** include a `schemas` field alongside `spec` and `paths`. This gives AI agents and tooling structured per-operation context without parsing raw OpenAPI:
```json
"schemas": {
  "/api/v1/users": {
    "post": {
      "parameters": [],
      "requestBody": { "required": true, "properties": ["name", "email"], "example": {...} },
      "responses": { "201": { "properties": ["id", "name"], "example": {...} } }
    }
  }
}
```

## Breaking Change Webhook

Set `BREAKING_CHANGE_WEBHOOK_URL` to receive a POST whenever a provider registers a breaking new version:

```json
{
  "provider": "payments-api",
  "from_version": "1.0.0",
  "to_version": "2.0.0",
  "breaking_changes": [
    { "type": "path_removed", "path": "/v1/payments/bulk", "detail": "Path /v1/payments/bulk was removed" }
  ],
  "affected_consumers": [
    { "service": "checkout-service", "missingPaths": ["/v1/payments/bulk"] }
  ],
  "timestamp": "2026-06-07T10:30:00Z"
}
```

Wire to Slack:
```bash
BREAKING_CHANGE_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/SLACK/WEBHOOK
```

Wire to a GitHub issue creation endpoint or PagerDuty alert similarly.

## Storage Backends

| `STORAGE_TYPE` | When to use | Persistence |
|----------------|------------|-------------|
| `memory` | Local dev, testing | Lost on restart |
| `postgres` | Self-hosted, local Docker Compose | Persistent |
| `dynamodb` | AWS-native, serverless | Persistent, managed |

For DynamoDB, create the table first:
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

## Service Discovery Modes

Set `DISCOVERY_MODE` for `fetch_service_contract` and `auto_discover_contracts`:

| Mode | Config | Use case |
|------|--------|---------|
| `kubernetes` | In-cluster SA token | Running inside K8s (IDP path) |
| `http` | `SERVICES_REGISTRY=svc1=http://url1,svc2=http://url2` | Docker Compose, ECS, bare metal |
| `docker` | `DOCKER_HOST` or `/var/run/docker.sock` | Local Docker development |

## AWS Deployment (ECS/Fargate)

1. **Push image to ECR:** build from `services/contract-mcp-server/Dockerfile`
2. **ECS task definition:** assign an IAM task role with DynamoDB access (if using DynamoDB storage)
3. **Database:** RDS Aurora PostgreSQL Serverless v2 (set `DATABASE_URL` in task env)
4. **Environment:** set `STORAGE_TYPE=postgres` (or `dynamodb`), `AWS_REGION`

For Kubernetes without Backstage (IRSA):
```bash
kubectl annotate serviceaccount contract-mcp-server \
  -n services-dev \
  eks.amazonaws.com/role-arn=<your-role-arn>
```

## IDP Integration (unchanged)

Teams using the full IDP platform continue to use `bootstrap-ai.sh` and KAgent — nothing changes. The Helm deployment (`helm-values-local.yaml`, `helm-values-aws.yaml`) still works. The standalone Docker Compose path is additive.
