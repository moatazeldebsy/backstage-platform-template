# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Repo Is

A GitHub template for a production-ready Internal Developer Platform. Running locally it uses Kind (Kubernetes in Docker) or Rancher Desktop (k3s); in AWS it uses EKS. The two entry points are `./scripts/setup.sh` (first-time) and `./scripts/bootstrap-local.sh` (day-2 cluster recreate).

## Common Commands

### AWS Deployment (Production)

```bash
# See: docs/PRE_DEPLOYMENT_CHECKLIST.md + docs/DEPLOYMENT_GUIDE.md

# CRITICAL: Verify all API keys are set (before deployment!)
./scripts/verify-secrets.sh
# Expected: ✅ All critical checks passed!

# First-time: personalise configuration and create S3 state bucket
./scripts/setup.sh

# Deploy full stack to AWS EKS (45-60 minutes)
./scripts/bootstrap.sh

# Validate deployment (50+ automated checks)
./scripts/validate-deployment.sh

# Deploy AI/ML stack (optional, requires ANTHROPIC_API_KEY)
./scripts/bootstrap-ai.sh

# Safe cleanup when done
./scripts/cleanup.sh --cluster-name idp-mvp --force
```

### Local/Kind Deployment (Development)

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
./scripts/bootstrap-local.sh --destroy                    # tear everything down (see Cleanup / Destroy below)
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

# Config-only changes (app-config.yaml / app-config.local.yaml / app-config.aws.yaml) just need a restart:
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

### AI/ML Platform (KAgent + MLflow)

**Prerequisites:**
- `ANTHROPIC_API_KEY` in `local/.env` (for Claude API via KAgent)
- `OPENAI_API_KEY` in `local/.env` (optional; for GPT-4o support via `modelconfig-openai`)

```bash
# Full AI/ML stack: KAgent, MLflow, MCP servers, OpenAI ModelConfig (if OPENAI_API_KEY set)
./scripts/bootstrap-ai.sh

# Selective deployment
./scripts/bootstrap-ai.sh --skip-mlflow     # skip MLflow tracking server
./scripts/bootstrap-ai.sh --skip-mcp        # skip MCP servers (idp, qa, contract)
./scripts/bootstrap-ai.sh --skip-kagent     # skip KAgent platform

# Teardown
./scripts/bootstrap-ai.sh --destroy
```

**AI-Native Platform Features (Phase 7a):**
- OpenAI ModelConfig CRD + GPT-4o support
- AI Observability Grafana dashboard (MCP tool metrics, latency, cost attribution)
- RAG doc indexing for semantic search across TechDocs
- Model Serving API template (Ollama local / vLLM AWS)
- AI Platform Scorecard (Bronze/Silver/Gold tiers with AI governance checks)
- Prompt Lifecycle Management (system prompts in ConfigMaps)
- Argo Workflows integration (ML pipeline orchestration)
- AI Cost Attribution (team labels + `ai_api_calls_total` metrics)

### Cleanup / Destroy

#### Local (Kind / Rancher Desktop)

```bash
./scripts/bootstrap-local.sh --destroy
```

Destroy sequence (in order, while the cluster is still up):
1. AI/ML teardown — calls `bootstrap-ai.sh --destroy` if `kagent`, `ml-platform`, or `services-dev` exist.
2. **Scaffolded service cleanup** — `_cleanup_scaffolded_services "local"` (defined in `scripts/lib.sh`):
   - Auto-discovers every `services/*/` directory that is not a platform built-in.
   - Platform built-ins never touched: `hello-service`, `idp-mcp-server`, `qa-mcp-server`, `contract-mcp-server`.
   - For each scaffolded service: deletes the ArgoCD Application (`<name>-local`, cascade), uninstalls the Helm release from `services-dev` and `services`, removes `services/<name>/` from the repo, commits + pushes (`[skip ci]`).
3. Kind cluster deleted (`kind delete cluster`) — or Rancher Desktop namespaces deleted.
4. Docker compose stack stopped; images and volumes pruned.
5. `/etc/hosts` entries removed.

**Not cleaned up (intentional):**
- `kubernetes/teams/<name>/` — team/org structure; safe and desirable to reapply on a new cluster.
- GitHub repos of scaffolded services — external, never auto-deleted.
- `test-suites/` — pre-committed demo content, not dynamically scaffolded into the platform repo.

#### AWS

```bash
./scripts/cleanup.sh --cluster-name idp-mvp --force
```

Eight ordered phases (while EKS is still up through Phase 4.5):

| Phase | What |
|---|---|
| 1 | Delete ALBs / Classic ELBs |
| 2 | Disable RDS deletion protection |
| 3 | Delete Crossplane-tagged resources (S3, RDS, DynamoDB, SQS) |
| 4 | Empty Terraform-managed S3 buckets + ECR repos |
| **4.5** | **Scaffolded service cleanup** — same logic as local: ArgoCD Applications deleted (cascade), Helm releases uninstalled, `services/<name>/` removed and committed |
| 5 | `terraform destroy` |
| 6 | Delete CloudWatch log groups |
| 7 | Verify all resources gone |

**Adding cleanup for a new scaffold type:** If a new template writes files into the platform repo under a directory other than `services/`, extend `_cleanup_scaffolded_services` in `scripts/lib.sh` to scan that directory too.

### MCP servers (idp-mcp-server, qa-mcp-server, contract-mcp-server)

**GitOps coverage of built-in services on a fresh install:**

| Service | Deployed by | ArgoCD ApplicationSet | Requires `bootstrap-ai.sh` |
|---|---|---|---|
| `hello-service` | ArgoCD (auto) | ✅ `services/hello-service/` picked up automatically | No |
| `idp-mcp-server` | ArgoCD (auto) + Helm fallback | ✅ `services/idp-mcp-server/` picked up automatically | No |
| `qa-mcp-server` | ArgoCD (auto) + Helm fallback | ✅ `services/qa-mcp-server/` picked up automatically | No |
| `contract-mcp-server` | `bootstrap-ai.sh` only | ❌ Explicitly excluded from ApplicationSet | Yes |

`contract-mcp-server` is excluded from the `idp-services` ApplicationSet in both `local/argocd/app-of-apps-local.yaml` and `aws/argocd/app-of-apps.yaml` — it is intentionally hidden from end users and only deployed as part of the AI/ML stack. Do not remove the exclusion rule without also updating `bootstrap-ai.sh`.

These run in `services-dev` namespace. On first install ArgoCD may not have the apps registered yet; `bootstrap-ai.sh` now falls back to direct Helm if the ArgoCD app is missing. To redeploy manually:

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

### Repository layout (three-way split)

| Directory | Owned by | Purpose |
|-----------|----------|---------|
| `local/` | `bootstrap-local.sh` | Kind cluster config, nginx values, Docker Compose, local ArgoCD app-of-apps, local Prometheus values, DORA exporter (local) |
| `aws/` | `bootstrap.sh` | EKS-specific: ArgoCD values + app-of-apps, External Secrets, Crossplane, Backstage K8s deployment, KAgent AWS values/ingress, ALB ingresses, MLflow (S3), Prometheus values (AWS), DORA exporter (AWS) |
| `kubernetes/` | Both | Shared only: namespaces, RBAC, OPA/Gatekeeper policies, teams, monitoring dashboards, KAgent agent CRDs |
| `services/<svc>/` | Per-service CI | Source, Dockerfile, `helm-values-local.yaml` (Kind/nginx), `helm-values-aws.yaml` (EKS/ALB) |

**Rule:** `bootstrap-local.sh` only reads `local/` + `kubernetes/`. `bootstrap.sh` only reads `aws/` + `kubernetes/`. No cross-reads.

### Deployment layers

```
Backstage Portal  ──────────────────────────────────────────┐
  custom scaffold actions (idp:deploy-local, etc.)           │ scaffold + deploy
  AI Assistant page (/ai-assistant) → native chat UI         │
  (backstage/app/packages/backend/src/modules/)              │
                                                             ▼
Kind / Rancher Desktop (local) or EKS (AWS)
  namespace: services-dev → hello-service, idp-mcp-server, qa-mcp-server (ArgoCD ApplicationSet via services/*)
                          → contract-mcp-server (Helm only via bootstrap-ai.sh — excluded from ApplicationSet)
                          → MCP servers emit mcp_tool_calls_total, mcp_tool_duration_seconds, ai_api_calls_total metrics
  namespace: services     → Helm chart (helm/service-template)
  namespace: monitoring   → Prometheus + Grafana + Pushgateway + ServiceMonitor (kagent namespace scraped for cost attribution)
  namespace: argocd       → ArgoCD (App-of-Apps)
  namespace: kagent       → KAgent agents (idp-assistant, qa-assistant, contract-assistant) with team labels for cost tracking
                          → ModelConfig CRDs (claude-anthropic, openai-prod)
  namespace: ml-platform  → MLflow tracking server, model inference servers (Ollama/vLLM)
  namespace: argo-workflows → Argo Workflows controller (optional; install with --install-argo-workflows flag)
  namespace: crossplane-system → Crossplane core + AWS providers (AWS only)
```

### IaC: Terraform + Crossplane (overlap by lifecycle, not by tool)

- **Terraform** (`terraform/`) — foundation: VPC, EKS, IAM/OIDC, ECR, Secrets Manager scaffolding, **and** the IRSA role Crossplane providers assume (`terraform/iam-crossplane.tf`). One-shot, platform-team-owned, applied from outside the cluster.
- **Crossplane** (`aws/crossplane/`) — per-service AWS resources requested via Backstage scaffolder templates: S3, RDS, Kafka topics, DynamoDB, SQS. Claims live at `services/<svc>/claims/*.yaml` and are synced by the existing `idp-services` ApplicationSet. AWS-only; the local Kind path is unchanged.
- Scaffolder templates come in pairs: `s3-bucket` (TF PR + manual `terraform apply`) and `s3-bucket-crossplane` (writes a Claim, ArgoCD syncs it). Choose by lifecycle; see `docs/crossplane-vs-terraform.md`.

### Backstage plugin system

The frontend uses Backstage's new declarative plugin API (`@backstage/frontend-plugin-api` v0.15+). Custom pages live in `backstage/app/packages/app/src/extensions.tsx` and are registered via `createFrontendPlugin` (use `pluginId`, not `id` — the old field name causes a TS error).

All custom Backstage backend scaffold actions are registered in `backstage/app/packages/backend/src/index.ts`. Each module is in `backstage/app/packages/backend/src/modules/`:

| Module | Action ID | Purpose |
|---|---|---|
| `idpLocalDeploy.ts` | `idp:deploy-local` | `helm upgrade --install` to Kind via `host.docker.internal` |
| `idpProvisionSecret.ts` | `idp:provision-secret` | Create a Kubernetes Secret |
| `idpSetRepoSecrets.ts` | `idp:set-repo-secrets` | Write GitHub Actions secrets |
| `idpTechInsights.ts` | `idp:tech-insights` | Push metrics to Prometheus Pushgateway; includes AI scorecard checks (v0.3.0+) |
| `idpDeployAgent.ts` | `idp:deploy-agent` | Deploy a KAgent Agent CRD |
| `idpRunTrainingJob.ts` | `idp:run-training-job` | Launch an MLflow training job |
| `idpDeployMcpServer.ts` | `idp:deploy-mcp-server` | Deploy an MCP server via Helm |
| `idpDeployModelServer.ts` | `idp:deploy-model-server` | Deploy a model inference server (Ollama local / vLLM AWS) with TLS verification |
| `idpRagSearch.ts` | (backend module) | Semantic search over catalog + TechDocs via RAG (Voyage AI + pgvector) |

**Critical**: All custom action modules import `scaffolderActionsExtensionPoint` from `@backstage/plugin-scaffolder-node` (the main package, **not** `/alpha`). The alpha export only has `scaffolderTemplatingExtensionPoint` which is a different extension point. Using the wrong import path causes the scaffolder plugin to crash at startup, which prevents the catalog refresh loop from running and leaves the catalog empty.

### Config layering

Three-file split — each env only reads what it needs:

| File | Used by | Purpose |
|------|---------|---------|
| `backstage/app-config.yaml` | Both | Env-agnostic base: DB, integrations, scaffolder, catalog rules, file: locations (volume-mounted locally), techInsights |
| `backstage/app-config.local.yaml` | Local/Docker Compose | Overrides: `.idp.local` baseUrls, listen port 3000, guest auth, SSL off, proxy → ingress hostnames, local techdocs |
| `backstage/app-config.aws.yaml` | AWS/EKS | Overrides: ALB URL, listen :7007, production auth, in-cluster DNS proxies, S3 techdocs, GitHub URL catalog locations |

The AWS deployment command is:
```
node packages/backend --config /config/app-config.yaml --config /config/app-config.aws.yaml
```
Both files are mounted as ConfigMaps (`backstage-base-config` and `backstage-config`) by `kubernetes/backstage/configmap.yaml`. `bootstrap.sh` patches the `BACKSTAGE_ALB_URL` placeholder in `backstage-config` after the ALB is provisioned.

Key local-only settings in `app-config.local.yaml`:
- `backend.auth.dangerouslyDisableDefaultAuthPolicy: true` — prevents 401 flash before sign-in completes
- `app.extensions: page:kubernetes: disabled: true` — disables the broken kubernetes standalone page (entity-tab K8s still works)
- `backend.listen.port: 3000` — Docker Compose maps port 3000; AWS uses :7007

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

**Adding a new proxy target:** Proxy endpoints are fully env-specific (no proxy in the base config). When adding a new in-cluster service:
1. Add the in-cluster DNS target to `proxy.endpoints` in `backstage/app-config.aws.yaml` (and mirror into `kubernetes/backstage/configmap.yaml` `backstage-config`)
2. Add the `*.idp.local` hostname override to `proxy.endpoints` in `backstage/app-config.local.yaml`
3. Add `- "hostname.idp.local:host-gateway"` to `extra_hosts` in `local/backstage/docker-compose.yml`
4. Add `127.0.0.1  hostname.idp.local` to `local/hosts-append.txt`

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
2. Register in **both** config files under `catalog.locations`:
   - `backstage/app-config.yaml` — add a `file:` entry (used locally via volume mount)
   - `backstage/app-config.aws.yaml` + `kubernetes/backstage/configmap.yaml` (`backstage-config`) — add a `url:` entry pointing to the GitHub raw URL (used by AWS)
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

The catalog reads entity files from `/catalog/...` (bind-mounted from `backstage/catalog/` on the host). At container startup, `moatazeldebsy` placeholders are replaced in-place with `$GITHUB_ORG` from `local/backstage/.env`.

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
| `ci.yml` | Push/PR to `services/`, `helm/`, `kubernetes/`, `aws/`, `terraform/`, `backstage/app/` | Go tests, `helm lint`, kubeconform, Backstage backend compile + Docker build, Terraform validate |
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
