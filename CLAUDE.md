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
# After any change to backstage/app/packages/ — the Dockerfile is multi-stage,
# so yarn install + yarn build:backend run INSIDE the image. No host build needed.
docker compose -f local/backstage/docker-compose.yml build backstage
docker compose -f local/backstage/docker-compose.yml up -d

# Config-only changes (app-config.yaml / app-config.local.yaml) just need a restart:
docker compose -f local/backstage/docker-compose.yml restart backstage

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

`yarn build:backend` uses esbuild in transpile-only mode — TypeScript type errors do not block the build. It runs inside the Backstage Docker builder stage; you do not need to run it on the host before `docker compose build backstage`.

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

### MCP servers (idp-mcp-server, qa-mcp-server, contract-mcp-server)

These run in `services-dev` namespace and are managed by ArgoCD. On first install ArgoCD may not have the apps registered yet; `bootstrap-ai.sh` now falls back to direct Helm if the ArgoCD app is missing. To redeploy manually:

```bash
helm upgrade --install idp-mcp-server helm/service-template \
  --namespace services-dev --create-namespace \
  --values services/idp-mcp-server/helm-values-local.yaml --wait

helm upgrade --install qa-mcp-server helm/service-template \
  --namespace services-dev --create-namespace \
  --values services/qa-mcp-server/helm-values-local.yaml --wait

helm upgrade --install contract-mcp-server helm/service-template \
  --namespace services-dev --create-namespace \
  --values services/contract-mcp-server/helm-values-local.yaml --wait
```

After any code change, rebuild the image and rolling-restart:

```bash
cd services/contract-mcp-server && docker build -t localhost:5003/contract-mcp-server:0.1.0 . && docker push localhost:5003/contract-mcp-server:0.1.0
kubectl rollout restart deployment/contract-mcp-server -n services-dev
```

The `contract-mcp-server` exposes 9 tools: `fetch_service_contract`, `auto_discover_contracts`, `register_contract`, `get_contract`, `list_contracts`, `generate_contract_tests`, `validate_compatibility`, `detect_breaking_changes`, `get_compatibility_report`. See `docs/contract-testing.md` for full usage.

## Architecture Overview

### Deployment layers

```
Backstage Portal  ──────────────────────────────────────────┐
  custom scaffold actions (idp:deploy-local, etc.)           │ scaffold + deploy
  AI Assistant page (/ai-assistant) → native chat UI         │
  (backstage/app/packages/backend/src/modules/)              │
                                                             ▼
Kind / Rancher Desktop (local) or EKS (AWS)
  namespace: services-dev → idp-mcp-server, qa-mcp-server, contract-mcp-server (Helm, managed by ArgoCD)
  namespace: services     → Helm chart (helm/service-template)
  namespace: monitoring   → Prometheus + Grafana + Pushgateway
  namespace: argocd       → ArgoCD (App-of-Apps)
  namespace: kagent       → KAgent + idp-assistant + IDP MCP Server
  namespace: ml-platform  → MLflow tracking server
  namespace: crossplane-system → Crossplane core + AWS providers (AWS only)
```

### IaC: Terraform + Crossplane (overlap by lifecycle, not by tool)

- **Terraform** (`terraform/`) — foundation: VPC, EKS, IAM/OIDC, ECR, Secrets Manager scaffolding, **and** the IRSA role Crossplane providers assume (`terraform/iam-crossplane.tf`). One-shot, platform-team-owned, applied from outside the cluster.
- **Crossplane** (`kubernetes/crossplane/`) — per-service AWS resources requested via Backstage scaffolder templates: S3, RDS, Kafka topics, DynamoDB, SQS. Claims live at `services/<svc>/claims/*.yaml` and are synced by the existing `idp-services` ApplicationSet. AWS-only; the local Kind path is unchanged.
- Scaffolder templates come in pairs: `s3-bucket` (TF PR + manual `terraform apply`) and `s3-bucket-crossplane` (writes a Claim, ArgoCD syncs it). Choose by lifecycle; see `docs/crossplane-vs-terraform.md`.

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

**Critical**: All custom action modules import `scaffolderActionsExtensionPoint` from `@backstage/plugin-scaffolder-node` (the main package, **not** `/alpha`). The alpha export only has `scaffolderTemplatingExtensionPoint` which is a different extension point. Using the wrong import path causes the scaffolder plugin to crash at startup, which prevents the catalog refresh loop from running and leaves the catalog empty.

### Config layering

`backstage/app-config.yaml` is the base. `backstage/app-config.local.yaml` overrides for local dev (guest auth, SSL off, proxy targets redirected from in-cluster DNS to ingress hostnames). Both are bind-mounted read-only by `local/backstage/docker-compose.yml`.

Key local-only settings in `app-config.local.yaml`:
- `backend.auth.dangerouslyDisableDefaultAuthPolicy: true` — prevents 401 flash before sign-in completes
- `app.extensions: page:kubernetes: disabled: true` — disables the broken kubernetes standalone page (entity-tab K8s still works)
- `app.extensions: page:catalog-graph: disabled: true` — disabled (broken standalone page)

### material-table / uuid patch

`@material-table/core` v3.x imports `uuid` as a default import (`_uuid["default"].v4()`) but `uuid` v10 removed its default export. This causes `TypeError: Cannot read properties of undefined (reading 'v4')` in the catalog, api-docs, and techdocs pages whenever they try to render a table with data.

**Fix**: A yarn patch at `.yarn/patches/@material-table-core-npm-3.2.5-*.patch` rewrites the call to `(_uuid["default"] || _uuid).v4()`. This is committed to the repo and applied automatically by `yarn install`. After any `yarn install` you can verify it's applied:

```bash
grep "uuid.*v4" backstage/app/node_modules/@material-table/core/dist/utils/data-manager.js
# Should show: (_uuid["default"] || _uuid).v4()
```

If the patch ever disappears, re-apply with:
```bash
cd backstage/app && yarn install  # applies patches from .yarn/patches/
```

**Critical local proxy override pattern:** The Backstage container runs in Docker and cannot reach `*.svc.cluster.local` DNS. All proxy targets that use in-cluster DNS in `app-config.yaml` must be overridden in `app-config.local.yaml` to use the corresponding `*.idp.local` ingress hostname instead. The `extra_hosts` block in `local/backstage/docker-compose.yml` maps these hostnames to `host-gateway` so the container can reach them.

When adding a new in-cluster proxy target for local use:
1. Add the `*.idp.local` hostname override to the proxy endpoint in `app-config.local.yaml`
2. Add `- "hostname.idp.local:host-gateway"` to `extra_hosts` in `local/backstage/docker-compose.yml`
3. Add `127.0.0.1  hostname.idp.local` to `local/hosts-append.txt`

### AI Assistant architecture

The `/ai-assistant` page in Backstage (`extensions.tsx`) is a native chat UI (not an iframe) that talks directly to the `idp-assistant` KAgent A2A agent via the Backstage proxy at `/api/proxy/kagent`. Each user turn POSTs to `/a2a/kagent/idp-assistant`, then polls `/api/sessions/<id>` for the streamed response.

The `idp-assistant` A2A agent is exposed at `http://idp-assistant.idp.local` via `kubernetes/kagent/ingress-idp-assistant.yaml`. The Backstage proxy (`/api/proxy/kagent`) points to this ingress in `app-config.local.yaml`.

**KAgent ingresses (local):** Both `kubernetes/kagent/ingress.yaml` (UI) and `ingress-idp-assistant.yaml` use plain HTTP — no TLS. `ssl-redirect: "false"` is set explicitly to prevent nginx from upgrading to HTTPS.

### KAgent agents and MCP servers

KAgent agents (`kubernetes/kagent/idp-agent.yaml`, `qa-agent.yaml`) reference tools from two RemoteMCPServer resources. The KAgent controller calls `tools/list` on startup to resolve tool metadata. If a tool is listed in an agent's `toolNames` but does not exist in the MCP server, the agent silently shows "No description available" in the UI.

The `idp-mcp-server` exposes 6 tools: `catalog_search`, `get_service_metrics`, `get_template_params`, `scaffold_service`, `list_deployments`, `list_templates`. The `get_template_params` tool fetches a template's full parameter schema via `/api/catalog/entities/by-name/Template/<namespace>/<name>`.

The `contract-mcp-server` exposes 9 tools for self-describing, self-testing APIs — see `docs/contract-testing.md`. It also has a KAgent `contract-assistant` agent (`kubernetes/kagent/contract-agent.yaml`). The `contract-assistant` uses all 9 contract tools plus `catalog_search` and `list_deployments` from idp-mcp-server.

**Critical**: The `enable-contract-testing` scaffold template uses the custom action `idp:setup-contract-testing` (`backstage/app/packages/backend/src/modules/idpSetupContractTesting.ts`). This action deploys the contract-mcp-server via Helm (writing values to a temp file), applies the KAgent CRDs via kubectl, waits for health, then calls `fetch_service_contract` to auto-register the target service. The JSON Schema type errors in this module (and all other action modules) are pre-existing and harmless — esbuild (transpile-only) ignores them.

To diagnose KAgent issues:
```bash
kubectl get agents -n kagent                          # check READY status
kubectl logs -n kagent deployment/kagent-controller --tail=30 | grep -E "error|registered"
kubectl describe agent <name> -n kagent               # see conditions
```

Built-in KAgent agents (promql-agent, etc.) may show READY=False briefly at startup if the controller reconciles before pods are ready. Restarting the controller clears stale conditions:
```bash
kubectl rollout restart deployment/kagent-controller -n kagent
```

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
3. Templates are bind-mounted; **no rebuild needed** — `docker compose -f local/backstage/docker-compose.yml restart backstage` is enough. Rebuild is only required if you changed `backstage/app/packages/`.

**Test-suite templates** (under `backstage/catalog/templates/*-suite/` and `*-test-suite/`) follow a standard shape:

- `template.yaml` — Backstage scaffolder form + steps
- `skeleton/` (optional) — for "new repo" mode, scaffolds a standalone test repo
- `skeleton-addon/test-suites/${{ values.name }}/` (or `skeleton-<lang>/`) — for "add to existing repo" mode, opens a PR against the target service's repo. This is the preferred mode for unit/component/IaC tests where the tests must live in the service repo.

The full pyramid is covered by these templates (one row per layer):

| Layer | Template(s) |
|---|---|
| Unit | language skeletons (`go-service`, `nodejs-service`, `python-service`); `unit-test-suite` for brownfield |
| Component | `component-test-suite` (WireMock-stubbed deps) |
| Integration | `testcontainers-suite` (real Postgres/Kafka in CI) |
| Contract | `enable-contract-testing` (MCP-driven, preferred); `pact-contract-suite`/`contract-testing-suite` (legacy) |
| E2E | `playwright-e2e-suite`, `newman-api-suite`, `bdd-cucumber-suite` |
| Performance | `k6-performance-suite` |
| Security (DAST) | `zap-dast-suite` |
| Visual | `visual-regression-suite` |
| Accessibility | `accessibility-suite` |
| Mobile | `appium-mobile-suite` |
| Chaos | `chaos-mesh-suite` |
| LLM eval | `deepeval-llm-eval-suite` |
| Mutation | `mutation-testing-suite` |
| Synthetic | `datadog-synthetic-suite` |
| IaC | `iac-test-suite` (tflint + Checkov + optional Terratest) |

## Backstage Catalog — How it works locally

The catalog reads entity files from `/catalog/...` (bind-mounted from `backstage/catalog/` on the host). At container startup, `YOUR_GITHUB_ORG` placeholders are replaced in-place with `$GITHUB_ORG` from `local/backstage/.env`.

Catalog state is in PostgreSQL (`backstage_plugin_catalog` database). Each plugin uses its own database (`backstage_plugin_<name>`). To diagnose empty catalog:

```bash
# Check entity counts in the DB
docker exec backstage-postgres-1 psql -U backstage backstage_plugin_catalog \
  -c "SELECT count(*) FROM refresh_state;" \
  -c "SELECT count(*) FROM final_entities;"

# Check Backstage logs for scaffolder/catalog errors
docker logs backstage-backstage-1 2>/dev/null | grep -E "error|scaffolder|catalog" | grep -v rootHttpRouter | tail -20
```

If `refresh_state` has entries but `final_entities` is 0, the catalog refresh loop is stuck — almost always caused by the scaffolder plugin crashing. Check the `scaffolderActionsExtensionPoint` import path in all backend modules.

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
| Contract MCP Server | http://contract-mcp-server.idp.local |
| Local registry | localhost:5003 |
