# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Repo Is

A GitHub template for a production-ready Internal Developer Platform. Running locally it uses Kind (Kubernetes in Docker); in AWS it uses EKS. The two entry points are `./scripts/setup.sh` (first-time) and `./scripts/bootstrap-local.sh` (day-2 cluster recreate).

## Common Commands

### Platform bootstrap

```bash
# First-time: personalises placeholders, then boots local or AWS
./scripts/setup.sh

# Day-2 local cluster recreate (skip observability for speed)
./scripts/bootstrap-local.sh              # cluster + platform
./scripts/bootstrap-local.sh --skip-obs  # skip Prometheus/Grafana for speed

# Then start Backstage (builds image, wires nginx, seeds metrics)
./scripts/bootstrap-local.sh --start-backstage

# Tear down
./scripts/bootstrap-local.sh --destroy
```

### Backstage (developer portal)

```bash
# Start Backstage after bootstrap-local.sh (builds image, wires nginx, seeds metrics)
./scripts/bootstrap-local.sh --start-backstage

# Rebuild backend bundle only (required after changes to backstage/app/packages/backend/src/)
cd backstage/app && yarn install && yarn build:backend && cd ../..
# Then re-run --start-backstage to pick up the new image

# Tear down Backstage only
docker compose -f local/backstage/docker-compose.yml down
```

### Backstage frontend/backend development (without Docker)

```bash
cd backstage/app
yarn install
yarn start          # frontend dev server (hot reload)
yarn start-backend  # backend dev server
yarn test           # run tests
yarn lint           # lint
yarn build          # production build
```

### hello-service (Go reference service)

```bash
cd services/hello-service
go test ./... -coverprofile=coverage.out -covermode=atomic
go build ./...
```

### Helm chart

```bash
helm lint helm/service-template
helm lint helm/service-template --set image.repository=test --set image.tag=abc1234
```

### Scaffold a new service (CLI golden path)

```bash
./scripts/create-service.sh --name my-svc --type nodejs
# types: nodejs | python | go

# Wire a self-hosted GitHub Actions runner for local CD
./scripts/setup-runner.sh --repo my-svc
```

### AI/ML platform (KAgent + MLflow)

```bash
# Prerequisites: ANTHROPIC_API_KEY must be set in local/.env
# Boot the AI/ML stack after bootstrap-local.sh
./scripts/bootstrap-ai.sh

# Options
./scripts/bootstrap-ai.sh --skip-mlflow   # skip MLflow
./scripts/bootstrap-ai.sh --skip-mcp      # skip IDP MCP Server build
./scripts/bootstrap-ai.sh --skip-kagent   # skip KAgent install
./scripts/bootstrap-ai.sh --destroy       # remove AI/ML stack only (core platform stays up)
```

| Service | URL |
|---------|-----|
| KAgent UI | http://kagent.idp.local |
| AI Assistant (Backstage) | http://backstage.idp.local/ai-assistant |
| MLflow UI | http://mlflow.idp.local |
| IDP MCP Server | http://idp-mcp-server.idp.local/healthz |

**AI Assistant — scaffolding in one message:**
Provide `name`, `description`, and `owner` together and the agent scaffolds immediately
without asking for confirmation. Example:
`"scaffold a Python FastAPI service called demo-svc, description demo, owner group:default/platform-team"`

**Key files for the AI Assistant:**
- `kubernetes/kagent/idp-agent.yaml` — Agent CRD (model, system message, tool allowlist)
- `services/idp-mcp-server/src/index.ts` — MCP server (6 tools)
- `backstage/app/packages/app/src/extensions.tsx` — Backstage chat UI (`AiAssistantPage`)
- `backstage/app-config.yaml` + `app-config.local.yaml` — KAgent proxy config

See `docs/ai-assistant.md` for the full architecture.

### Scaffold a QA test suite (CLI golden path)

```bash
./scripts/create-test-suite.sh --name my-e2e  --type playwright    --service my-svc
./scripts/create-test-suite.sh --name my-perf --type k6            --service my-svc --vus 20 --duration 2m
./scripts/create-test-suite.sh --name my-a11y --type accessibility --service my-svc --wcag wcag2aa
./scripts/create-test-suite.sh --help   # all types and flags

# types: playwright | k6 | pact | newman | zap | datadog | visual |
#        accessibility | cucumber | appium | chaos | mutation | testcontainers
# Output: test-suites/<name>/ with catalog-info.yaml, test files, CI workflow
```

## Architecture Overview

### Deployment layers

```
Backstage Portal  ──────────────────────────────────────────┐
  custom action: idp:deploy-local                            │ scaffold + deploy
  AI Assistant page (/ai-assistant) ──► KAgent proxy         │
  (backstage/app/packages/backend/src/modules/idpLocalDeploy.ts)
                                                             ▼
Kind cluster (local) / EKS (AWS)
  namespace: services    → Helm chart (helm/service-template)
  namespace: monitoring  → Prometheus + Grafana
  namespace: argocd      → ArgoCD (local only)
  namespace: kagent      → KAgent + idp-assistant Agent + IDP MCP Server
  namespace: ml-platform → MLflow tracking server
```

### Single Helm chart for everything

`helm/service-template/` is the only deployment abstraction. All scaffolded services inherit it and only override `helm-values.yaml` / `helm-values-local.yaml`. There is no raw Kubernetes YAML for service workloads.

### Custom Backstage action (`idp:deploy-local`)

Registered as a backend module in `backstage/app/packages/backend/src/index.ts`. It runs `helm upgrade --install` from inside the Backstage container, using a kubeconfig that replaces `127.0.0.1` with `host.docker.internal` so it can reach the host's Kind cluster. Environment variable `KUBECONFIG=/tmp/kubeconfig` is always injected.

### Config layering

`backstage/app-config.yaml` is the base. `backstage/app-config.local.yaml` overrides it for local (guest auth, SSL off, static catalog-exporter token). Both files are bind-mounted read-only into the Backstage container by `local/backstage/docker-compose.yml`.

### Environment files

| File | Purpose |
|------|---------|
| `local/.env` | Shared tokens: `GITHUB_TOKEN`, `AWS_REGION`, cluster name |
| `local/backstage/.env` | Backstage tokens: `AUTH_GITHUB_CLIENT_ID/SECRET`, `K8S_*`, `BACKSTAGE_AUTH_SECRET` |

Both have `.env.example` counterparts. Neither is committed.

### AWS infrastructure

Terraform in `terraform/` provisions EKS, VPC, ECR, IAM (OIDC for keyless CI/CD + IRSA for pod-level AWS access), RDS, S3, and Secrets Manager. CI/CD uses `aws-actions/configure-aws-credentials` with OIDC — no long-lived secrets.

## Adding a Software Template

1. Create `backstage/catalog/templates/<template-name>/template.yaml` + `skeleton/`
2. Register the location in `backstage/app-config.yaml` under `catalog.locations`
3. Rebuild and restart Backstage (`yarn build:backend` + `docker compose build/up`)

## CI

GitHub Actions (`.github/workflows/ci.yml`) triggers on changes to `services/`, `helm/`, `kubernetes/`, `terraform/`, `backstage/app/`. Jobs: Go tests with coverage, `helm lint`, Kubernetes dry-run validation.

## Local Access URLs

After `bootstrap-local.sh`, all entries in `local/hosts-append.txt` are written to `/etc/hosts` automatically.

| Service | URL |
|---------|-----|
| Backstage | http://backstage.idp.local |
| hello-service | http://hello-service.idp.local |
| Grafana | http://grafana.idp.local (admin/admin) |
| ArgoCD | http://argocd.idp.local |
| Prometheus | http://prometheus.idp.local |
| Local registry | localhost:5003 |
