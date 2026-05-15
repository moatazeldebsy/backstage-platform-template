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
yarn test           # run all tests
yarn test --testPathPattern=idpLocalDeploy  # run a single test file
yarn lint           # lint
yarn build          # production build
```

### hello-service (Go reference service)

```bash
cd services/hello-service
go test ./... -coverprofile=coverage.out -covermode=atomic  # all tests
go test -run TestHandlerName ./...                          # single test
go build ./...
```

### `idp` CLI (separate Go module at `cli/`)

```bash
# Build
make cli-build          # outputs ./bin/idp
make cli-install        # go install → $(go env GOPATH)/bin/idp
make cli-clean

# Test the CLI itself (cli/ is a separate go.mod — not covered by CI)
cd cli && go build ./... && go vet ./...
```

### Helm chart

```bash
helm lint helm/service-template
helm lint helm/service-template --set image.repository=test --set image.tag=abc1234
```

### Terraform

```bash
cd terraform
terraform fmt -recursive        # format before committing
terraform init -backend=false   # validate without remote state
terraform validate
```

### Scaffold a new service (`idp` CLI — golden path)

```bash
# Scaffold a service — uses Backstage Scaffolder API when running, local generation otherwise
./bin/idp scaffold service --name my-svc --type nodejs
./bin/idp scaffold service --name my-svc --type python
./bin/idp scaffold service --name my-svc --type go
# types: nodejs | python | go

# Force local generation (offline / pre-Backstage)
./bin/idp scaffold service --name my-svc --type nodejs --local
```

**Backstage API mode** (when `http://backstage.idp.local` is reachable): creates GitHub repo,
registers the service in the catalog, opens a GitOps PR, generates TechDocs.

**Local mode** (offline fallback): generates `services/<name>/` with Dockerfile, CI workflow,
Helm values, and `catalog-info.yaml` directly in this repo.

**CLI Backstage token resolution** (priority order):
1. `--token` flag
2. `BACKSTAGE_TOKEN` env var
3. `BACKSTAGE_AUTH_SECRET` in `local/backstage/.env`
4. Static token parsed from `backstage/app-config.local.yaml`

```bash
# Wire a self-hosted GitHub Actions runner for local CD (optional)
./scripts/setup-runner.sh --repo my-svc
```

### AI/ML platform (KAgent + MLflow)

```bash
# Prerequisites: ANTHROPIC_API_KEY must be set in local/.env
./scripts/bootstrap-ai.sh

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
- `services/idp-mcp-server/src/index.ts` — MCP server (5 tools)
- `backstage/app/packages/app/src/extensions.tsx` — Backstage chat UI (`AiAssistantPage`)
- `backstage/app-config.yaml` + `app-config.local.yaml` — KAgent proxy config

**IDP MCP Server tools** (`services/idp-mcp-server/src/index.ts`):

| Tool | Purpose |
|------|---------|
| `catalog_search` | Search Backstage catalog by keyword; filterable by kind (Component/API/System/Resource) |
| `get_service_metrics` | Query Prometheus for a service's metrics (default: `http_requests_total`) |
| `scaffold_service` | Trigger Backstage scaffolder; auto-builds `repoUrl` from `name`+`owner` if omitted |
| `list_deployments` | List Kubernetes Deployments in a namespace with readiness status |
| `list_templates` | List all Backstage templates (returns `templateRef` strings ready for `scaffold_service`) |

See `docs/ai-assistant.md` for the full architecture.

### Scaffold a QA test suite (`idp` CLI — golden path)

```bash
./bin/idp scaffold test-suite --name my-e2e  --type playwright    --service my-svc
./bin/idp scaffold test-suite --name my-perf --type k6            --service my-svc --vus 20 --duration 2m
./bin/idp scaffold test-suite --name my-a11y --type accessibility --service my-svc --wcag wcag2aa
./bin/idp scaffold test-suite --name sec-scan   --type zap        --service my-svc --scan-type baseline
./bin/idp scaffold test-suite --name contracts  --type pact       --service my-svc
./bin/idp scaffold test-suite --name api-tests  --type newman     --service my-svc
./bin/idp scaffold test-suite --name synthetics --type datadog    --service my-svc
./bin/idp scaffold test-suite --name visual     --type visual     --service my-svc --threshold 0.1
./bin/idp scaffold test-suite --name bdd-suite  --type cucumber   --service my-svc
./bin/idp scaffold test-suite --name mobile     --type appium     --service my-svc --platform ios
./bin/idp scaffold test-suite --name chaos      --type chaos      --service my-svc --chaos-duration 2m
./bin/idp scaffold test-suite --name mutation   --type mutation   --service my-svc --score 80
./bin/idp scaffold test-suite --name int-tests  --type testcontainers --service my-svc --containers postgres,redis

./bin/idp scaffold test-suite --help            # show all flags for a type
./bin/idp scaffold test-suite --name my-e2e --type playwright --service my-svc --local  # offline
```

**Types:** `playwright` | `k6` | `pact` | `newman` | `zap` | `datadog` | `visual` |
`accessibility` | `cucumber` | `appium` | `chaos` | `mutation` | `testcontainers`

**Output:** `test-suites/<name>/` with `catalog-info.yaml`, `mkdocs.yml`, type-specific test files.

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

### Custom Backstage scaffold modules

All registered in `backstage/app/packages/backend/src/index.ts`. Each module lives in `backstage/app/packages/backend/src/modules/`:

| Module file | Scaffold action ID | Purpose |
|---|---|---|
| `idpLocalDeploy.ts` | `idp:deploy-local` | `helm upgrade --install` to Kind via `host.docker.internal` |
| `idpProvisionSecret.ts` | `idp:provision-secret` | Create a Kubernetes Secret in a namespace |
| `idpSetRepoSecrets.ts` | `idp:set-repo-secrets` | Write GitHub Actions secrets for a repo |
| `idpTechInsights.ts` | `idp:tech-insights` | Push tech-insights metrics to Prometheus Pushgateway |
| `idpDeployAgent.ts` | `idp:deploy-agent` | Deploy a KAgent Agent CRD to the cluster |
| `idpRunTrainingJob.ts` | `idp:run-training-job` | Launch an MLflow training job |
| `idpDeployMcpServer.ts` | `idp:deploy-mcp-server` | Deploy an MCP server via Helm |

### Config layering

`backstage/app-config.yaml` is the base. `backstage/app-config.local.yaml` overrides it for local (guest auth, SSL off, static catalog-exporter token). Both files are bind-mounted read-only into the Backstage container by `local/backstage/docker-compose.yml`.

### Environment files

| File | Purpose |
|------|---------|
| `local/.env` | Shared tokens: `GITHUB_TOKEN`, `AWS_REGION`, `ANTHROPIC_API_KEY`, cluster name |
| `local/backstage/.env` | Backstage tokens: `AUTH_GITHUB_CLIENT_ID/SECRET`, `K8S_*`, `BACKSTAGE_AUTH_SECRET` |

Both have `.env.example` counterparts. Neither is committed. `K8S_*` and `ARGOCD_AUTH_TOKEN`/`GRAFANA_TOKEN` in `local/backstage/.env` are auto-populated by bootstrap scripts — do not set manually.

### Go module boundaries

`cli/` (`github.com/moatazeldebsy/backstage-idp-starter/cli`) and `services/hello-service/` (`github.com/idp-mvp/hello-service`) are independent Go modules with their own `go.mod`. CI only covers `services/hello-service/` — changes to `cli/` are not automatically tested.

### AWS infrastructure

Terraform in `terraform/` provisions EKS, VPC, ECR, IAM (OIDC for keyless CI/CD + IRSA for pod-level AWS access), RDS, S3, and Secrets Manager. CI/CD uses `aws-actions/configure-aws-credentials` with OIDC — no long-lived secrets.

### `kubernetes/` directory structure

| Directory | Contents |
|-----------|---------|
| `namespaces/` | Namespace manifests for services, monitoring, argocd, kagent, ml-platform; also ExternalSecrets |
| `rbac/` | GitHub Actions OIDC binding + RBAC roles (validated by kubeconform in CI) |
| `kagent/` | KAgent CRDs: `idp-agent.yaml` (AI assistant) + `qa-agent.yaml`; MCP toolserver configs |
| `argocd/` | App-of-Apps pattern + Helm values for ArgoCD itself |
| `monitoring/` | ServiceMonitor (Prometheus scrape config) + Grafana ConfigMaps (DORA + QA dashboards) |
| `ingress/` | nginx ingress (local) + AWS ALB (production) |
| `policies/` | Kyverno policies: health probes, labels, resource limits, no-latest-tag, cost tags |
| `finops/` | OpenCost for cost attribution |
| `external-secrets/` | ExternalSecrets operator config to sync from AWS Secrets Manager |
| `teams/` | Team-scoped NetworkPolicies |

### Backstage software templates (`backstage/catalog/templates/`)

Service templates: `nodejs-service`, `python-service`, `go-service`, `react-frontend`
Infrastructure templates: `terraform-module`, `kafka-topic`, `rds-database`, `s3-bucket`, `team-namespace`
Platform templates: `deploy-to-kind`, `add-secret`, `ai-agent-kagent`, `mlflow-experiment`, `mcp-server`

## Adding a Software Template

1. Create `backstage/catalog/templates/<template-name>/template.yaml` + `skeleton/`
2. Register the location in `backstage/app-config.yaml` under `catalog.locations`
3. Rebuild and restart Backstage (`yarn build:backend` + `docker compose build/up`)

## CI

| Workflow | Trigger | What it does |
|----------|---------|--------------|
| `ci.yml` | Push/PR to `services/`, `helm/`, `kubernetes/`, `terraform/`, `backstage/app/` | Go tests + coverage, `helm lint`, kubeconform (`namespaces/`, `rbac/`), Backstage backend compile + Docker build, Terraform `fmt`/`init`/`validate` |
| `build-and-deploy.yml` | Push to service directories | Change detection → runtime-based matrix (Go/Node/Python auto-detected) → GHCR image build → ArgoCD sync |
| `auto-merge-onboarding.yml` | PRs titled "feat: onboard …" | Auto-approves and merges if only `services/*/helm-values-*.yaml` changed; requires `GH_PAT` secret |
| `docs.yml` | Changes to `docs/` or `mkdocs.yml` | Builds and deploys MkDocs site to GitHub Pages |

Changes to `cli/` do **not** trigger CI.

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
