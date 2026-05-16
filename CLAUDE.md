# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Repo Is

A GitHub template for a production-ready Internal Developer Platform. Running locally it uses Kind (Kubernetes in Docker) or Rancher Desktop (k3s); in AWS it uses EKS. The two entry points are `./scripts/setup.sh` (first-time) and `./scripts/bootstrap-local.sh` (day-2 cluster recreate).

## Common Commands

### Platform bootstrap

```bash
# First-time setup — personalises placeholders, creates .env files, boots cluster
./scripts/setup.sh

# Set provider before setup if using Rancher Desktop (not Kind)
# Add KUBERNETES_PROVIDER=rancher-desktop to local/.env first

# Day-2 bootstrap flags
./scripts/bootstrap-local.sh                              # Kind (default): cluster + platform
./scripts/bootstrap-local.sh --full                       # cluster + platform + Backstage in one shot
./scripts/bootstrap-local.sh --provider rancher-desktop   # use Rancher Desktop k3s instead of Kind
./scripts/bootstrap-local.sh --skip-obs                   # skip Prometheus/Grafana (faster)
./scripts/bootstrap-local.sh --start-backstage            # Backstage only (cluster already up)
./scripts/bootstrap-local.sh --install-pushgateway        # install/repair Pushgateway + seed QA metrics
./scripts/bootstrap-local.sh --install-argocd             # install/repair ArgoCD + register GitHub creds
./scripts/bootstrap-local.sh --print-urls                 # print all service URLs without bootstrapping
./scripts/bootstrap-local.sh --destroy                    # tear everything down
```

**Rancher Desktop prerequisites (one-time):**
1. Preferences → Kubernetes → disable Traefik
2. Preferences → Container Engine → set to dockerd
3. Set `KUBERNETES_PROVIDER=rancher-desktop` in `local/.env`

### Backstage (developer portal)

```bash
# After any change to backstage/app/packages/ — rebuild bundle then rebuild image
cd backstage/app && yarn build:backend && cd ../..
docker compose -f local/backstage/docker-compose.yml build backstage
docker compose -f local/backstage/docker-compose.yml up -d

# Shortcut: rebuild + restart in one step
./scripts/bootstrap-local.sh --start-backstage

# Tear down Backstage only
docker compose -f local/backstage/docker-compose.yml down
```

### Backstage frontend/backend development (without Docker)

```bash
cd backstage/app
yarn install
yarn start          # frontend dev server (hot reload) — test UI changes immediately at localhost:3000
yarn start-backend  # backend dev server
yarn test           # run all tests
yarn test --testPathPattern=idpLocalDeploy  # run a single test file
yarn lint
yarn build          # production build
```

### hello-service (Go reference service)

```bash
cd services/hello-service
go test ./... -coverprofile=coverage.out -covermode=atomic
go test -run TestHandlerName ./...
go build ./...
```

### `idp` CLI (separate Go module at `cli/`)

```bash
make cli-build          # outputs ./bin/idp
make cli-install        # go install → $(go env GOPATH)/bin/idp
cd cli && go build ./... && go vet ./...
```

### Helm / Terraform

```bash
helm lint helm/service-template
helm lint helm/service-template --set image.repository=test --set image.tag=abc1234

cd terraform
terraform fmt -recursive
terraform init -backend=false && terraform validate
```

### Scaffold a new service

```bash
./bin/idp scaffold service --name my-svc --type nodejs   # nodejs | python | go
./bin/idp scaffold service --name my-svc --type go --local  # offline/local generation
```

### AI/ML platform (KAgent + MLflow)

```bash
# Prerequisites: ANTHROPIC_API_KEY in local/.env
./scripts/bootstrap-ai.sh
./scripts/bootstrap-ai.sh --skip-mlflow | --skip-mcp | --skip-kagent
./scripts/bootstrap-ai.sh --destroy
```

## Architecture Overview

### Deployment layers

```
Backstage Portal  ──────────────────────────────────────────┐
  custom scaffold actions (idp:deploy-local, etc.)           │ scaffold + deploy
  AI Assistant page (/ai-assistant) → iframe → kagent-ui     │
  (backstage/app/packages/backend/src/modules/)              │
                                                             ▼
Kind / Rancher Desktop (local) or EKS (AWS)
  namespace: services    → Helm chart (helm/service-template)
  namespace: monitoring  → Prometheus + Grafana + Pushgateway
  namespace: argocd      → ArgoCD (App-of-Apps)
  namespace: kagent      → KAgent + idp-assistant + IDP MCP Server
  namespace: ml-platform → MLflow tracking server
```

### Backstage plugin system

The frontend uses Backstage's new declarative plugin API (`@backstage/frontend-plugin-api` v0.15+). Custom pages live in `backstage/app/packages/app/src/extensions.tsx` and are registered via `createFrontendPlugin` (use `pluginId`, not `id` — the old field name causes a TS error).

All custom Backstage backend scaffold actions are registered in `backstage/app/packages/backend/src/index.ts`. Each module is in `backstage/app/packages/backend/src/modules/`:

| Module | Action ID | Purpose |
|---|---|---|
| `idpLocalDeploy.ts` | `idp:deploy-local` | `helm upgrade --install` to Kind via `host.docker.internal` |
| `idpProvisionSecret.ts` | `idp:provision-secret` | Create a Kubernetes Secret |
| `idpSetRepoSecrets.ts` | `idp:set-repo-secrets` | Write GitHub Actions secrets |
| `idpTechInsights.ts` | `idp:tech-insights` | Push metrics to Prometheus Pushgateway |
| `idpDeployAgent.ts` | `idp:deploy-agent` | Deploy a KAgent Agent CRD |
| `idpRunTrainingJob.ts` | `idp:run-training-job` | Launch an MLflow training job |
| `idpDeployMcpServer.ts` | `idp:deploy-mcp-server` | Deploy an MCP server via Helm |

### Config layering

`backstage/app-config.yaml` is the base. `backstage/app-config.local.yaml` overrides for local dev (guest auth, SSL off, proxy targets redirected from in-cluster DNS to ingress hostnames). Both are bind-mounted read-only by `local/backstage/docker-compose.yml`.

**Critical local proxy override pattern:** The Backstage container runs in Docker and cannot reach `*.svc.cluster.local` DNS. All proxy targets that use in-cluster DNS in `app-config.yaml` must be overridden in `app-config.local.yaml` to use the corresponding `*.idp.local` ingress hostname instead. The `extra_hosts` block in `local/backstage/docker-compose.yml` maps these hostnames to `host-gateway` so the container can reach them.

When adding a new in-cluster proxy target for local use:
1. Add the `*.idp.local` hostname override to the proxy endpoint in `app-config.local.yaml`
2. Add `- "hostname.idp.local:host-gateway"` to `extra_hosts` in `local/backstage/docker-compose.yml`
3. Add `127.0.0.1  hostname.idp.local` to `local/hosts-append.txt`

### AI Assistant architecture

The `/ai-assistant` page in Backstage (`extensions.tsx`) embeds the KAgent UI (`http://kagent.idp.local/agents`) in an iframe. The KAgent UI nginx is patched (via ConfigMap `kagent-ui-config`) to set `Content-Security-Policy: frame-ancestors *` so Chrome allows the cross-origin iframe.

The `idp-assistant` A2A agent is exposed at `http://idp-assistant.idp.local` via `kubernetes/kagent/ingress-idp-assistant.yaml`. The Backstage proxy (`/api/proxy/kagent`) points to this ingress in `app-config.local.yaml`.

**KAgent ingresses (local):** Both `kubernetes/kagent/ingress.yaml` (UI) and `ingress-idp-assistant.yaml` use plain HTTP — no TLS. `ssl-redirect: "false"` is set explicitly to prevent nginx from upgrading to HTTPS.

### Environment files

| File | Purpose |
|------|---------|
| `local/.env` | `GITHUB_TOKEN`, `AWS_REGION`, `ANTHROPIC_API_KEY`, `KUBERNETES_PROVIDER`, cluster name |
| `local/backstage/.env` | `AUTH_GITHUB_CLIENT_ID/SECRET`, `K8S_*`, `BACKSTAGE_AUTH_SECRET`, `ARGOCD_AUTH_TOKEN` |

Both have `.env.example` counterparts. `K8S_*`, `ARGOCD_AUTH_TOKEN`, and `GRAFANA_TOKEN` are auto-populated by bootstrap scripts — do not set manually.

### Single Helm chart

`helm/service-template/` is the only deployment abstraction. All scaffolded services only override `helm-values.yaml` / `helm-values-local.yaml`. No raw Kubernetes YAML for service workloads.

### Go module boundaries

`cli/` and `services/hello-service/` are independent Go modules with their own `go.mod`. CI only covers `services/hello-service/` — `cli/` changes are not automatically tested.

### AWS infrastructure

Terraform in `terraform/` provisions EKS, VPC, ECR, IAM (OIDC + IRSA). CI/CD uses `aws-actions/configure-aws-credentials` with OIDC — no long-lived secrets.

## Adding a Software Template

1. Create `backstage/catalog/templates/<template-name>/template.yaml` + `skeleton/`
2. Register in `backstage/app-config.yaml` under `catalog.locations`
3. Rebuild Backstage: `yarn build:backend` → `docker compose build/up`

## CI

| Workflow | Trigger | What it does |
|----------|---------|--------------|
| `ci.yml` | Push/PR to `services/`, `helm/`, `kubernetes/`, `terraform/`, `backstage/app/` | Go tests, `helm lint`, kubeconform, Backstage backend compile + Docker build, Terraform validate |
| `build-and-deploy.yml` | Push to service directories | Change detection → runtime matrix → GHCR image → ArgoCD sync |
| `auto-merge-onboarding.yml` | PRs titled "feat: onboard …" | Auto-approves if only `helm-values-*.yaml` changed; requires `GH_PAT` |
| `docs.yml` | Changes to `docs/` or `mkdocs.yml` | MkDocs → GitHub Pages |

Changes to `cli/` do **not** trigger CI.

## Local Access URLs

`bootstrap-local.sh` writes all entries from `local/hosts-append.txt` to `/etc/hosts` automatically. `bootstrap-ai.sh` adds the AI/ML entries.

| Service | URL |
|---------|-----|
| Backstage | http://backstage.idp.local |
| hello-service | http://hello-service.idp.local |
| ArgoCD | http://argocd.idp.local |
| Grafana | http://grafana.idp.local (admin/admin) |
| Prometheus | http://prometheus.idp.local |
| Pushgateway | http://pushgateway.idp.local |
| OpenCost | http://opencost.idp.local |
| KAgent UI | http://kagent.idp.local |
| AI Assistant | http://backstage.idp.local/ai-assistant |
| IDP Assistant (A2A) | http://idp-assistant.idp.local |
| MLflow | http://mlflow.idp.local |
| Local registry | localhost:5003 |
