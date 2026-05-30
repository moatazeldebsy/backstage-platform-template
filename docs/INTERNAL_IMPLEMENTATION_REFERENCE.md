# Internal Platform Implementation Reference

> **PRIVATE — not for publication.**
> This document captures how every layer of this IDP was built, the decisions behind each choice, and the gotchas that cost time. Written for the platform engineer who built it, not for end users.

---

## Table of Contents

1. [Platform Philosophy & Design Principles](#1-platform-philosophy--design-principles)
2. [Repository Layout & Environment Separation](#2-repository-layout--environment-separation)
3. [Phase 1 — Infrastructure Foundation (Terraform)](#3-phase-1--infrastructure-foundation-terraform)
4. [Phase 2 — CI/CD Golden Path (GitHub Actions)](#4-phase-2--cicd-golden-path-github-actions)
5. [Phase 3 — Helm Service Template](#5-phase-3--helm-service-template)
6. [Phase 4 — Backstage Developer Portal](#6-phase-4--backstage-developer-portal)
7. [Phase 5 — Observability Stack](#7-phase-5--observability-stack)
8. [Phase 6 — hello-service Reference Implementation](#8-phase-6--hello-service-reference-implementation)
9. [Phase 7 — Local Deployment Action (idp:deploy-local)](#9-phase-7--local-deployment-action-idpdeploy-local)
10. [Phase 8 — GitOps with ArgoCD](#10-phase-8--gitops-with-argocd)
11. [Phase 9 — CD Pipeline (ECR → EKS)](#11-phase-9--cd-pipeline-ecr--eks)
12. [Phase 10 — Policy Enforcement](#12-phase-10--policy-enforcement)
13. [Phase 11 — Crossplane Self-Service Resources](#13-phase-11--crossplane-self-service-resources)
14. [Phase 12 — AI/ML Platform (KAgent + MLflow + MCP Servers)](#14-phase-12--aiml-platform-kagent--mlflow--mcp-servers)
15. [Phase 13 — QA Templates & Shift-Left Program](#15-phase-13--qa-templates--shift-left-program)
16. [Bootstrap Scripts & Operational Runbook](#16-bootstrap-scripts--operational-runbook)
17. [Key Design Decisions & Hard-Won Gotchas](#17-key-design-decisions--hard-won-gotchas)
18. [Component Versions](#18-component-versions)

---

## 1. Platform Philosophy & Design Principles

### Why this repo exists

This is a GitHub template for a production-ready Internal Developer Platform. The goal is a single `git clone` + one script that gives a team either a full local Kind cluster or a production EKS deployment. Everything from infrastructure to developer portal to AI agents is wired up by default.

### Core design principles

**Convention over configuration.** Every service uses the same Helm chart (`helm/service-template`). Service owners only override `helm-values-local.yaml` and `helm-values-aws.yaml`. No raw Kubernetes YAML for service workloads.

**Local mirrors prod.** `bootstrap-local.sh` and `bootstrap.sh` install the same stack (nginx vs ALB, local Prometheus vs CloudWatch-connected Prometheus, Kind registry vs ECR). Developers debug the same config their CI runs.

**Helm as the deployment unit.** One chart to deploy anything. The chart handles health probes, service monitors, ingress class switching, resource limits, and RBAC. Teams don't write Kubernetes YAML.

**IaC split: Terraform for foundation, Crossplane for day-2.** Terraform (VPC, EKS, RDS, IAM, ECR, Secrets Manager) is applied once by the platform team. Crossplane XRDs + Claims handle per-service cloud resources requested through Backstage templates.

**No long-lived credentials.** GitHub Actions uses OIDC (no static AWS keys). Pods use IRSA. Secrets flow through External Secrets Operator from AWS Secrets Manager.

**GitOps as source of truth.** ArgoCD ApplicationSet auto-discovers every `services/*/helm-values-*.yaml`. Deploying a service = merging a PR.

**Placeholder substitution, not templating.** `setup.sh` does a one-time find-and-replace of `moatazeldebsy` (GitHub org), `123456789012` (AWS account), etc. across ~542 files. After that, every script re-reads `.idp-config.env`. No Jinja, no Helm for infra, just `sed`.

---

## 2. Repository Layout & Environment Separation

```
backstage-platform-template/
├── terraform/           # Foundation IaC (platform team, one-shot)
├── local/               # Kind-only: nginx values, docker-compose, local ArgoCD
├── aws/                 # EKS-only: ALB ingresses, External Secrets, Crossplane, MLflow S3
├── kubernetes/          # Shared by both: namespaces, RBAC, policies, monitoring, kagent
├── backstage/           # Developer portal (app/ monorepo + catalog/ + config files)
├── services/            # hello-service + 3 MCP servers (source + Helm values)
├── helm/                # Single shared Helm chart
├── cli/                 # idp CLI (Go, separate go.mod)
├── observability/       # Grafana dashboards, SLO definitions, alerting
├── test-suites/         # Pre-committed demo test suite scaffolds
├── scripts/             # All bootstrap + operational scripts
├── docs/                # Documentation (this file lives here)
└── .github/workflows/   # CI/CD pipelines
```

**Strict rule:** `bootstrap-local.sh` only reads `local/` + `kubernetes/`. `bootstrap.sh` only reads `aws/` + `kubernetes/`. Nothing cross-reads. This avoids accidental environment contamination.

### Three-environment config split (Backstage)

| File | Used by | Key content |
|------|---------|-------------|
| `backstage/app-config.yaml` | Both | DB, integrations, scaffolder, catalog rules, file: locations |
| `backstage/app-config.local.yaml` | Local Docker Compose | baseUrls `.idp.local`, port 3000, guest auth, proxy → ingress hostnames |
| `backstage/app-config.aws.yaml` | EKS | ALB URL, port 7007, GitHub auth, in-cluster DNS proxies, S3 techdocs |

AWS command: `node packages/backend --config /config/app-config.yaml --config /config/app-config.aws.yaml`

Both config files are mounted as two separate ConfigMaps (`backstage-base-config` and `backstage-config`) by `kubernetes/backstage/configmap.yaml`.

---

## 3. Phase 1 — Infrastructure Foundation (Terraform)

**Files:** `terraform/*.tf`

### What Terraform provisions

| File | Resource |
|------|---------|
| `vpc.tf` | VPC, public/private subnets, NAT gateway, route tables |
| `eks.tf` | EKS cluster (K8s 1.29), managed node groups, add-ons (VPC CNI, CoreDNS, kube-proxy) |
| `iam.tf` | OIDC provider, GitHub Actions IRSA role, cluster access roles |
| `iam-crossplane.tf` | IRSA role for Crossplane providers (S3/RDS/SQS/DynamoDB/MSK) |
| `ecr.tf` | ECR repositories per service |
| `rds.tf` | RDS PostgreSQL (db.t3.micro, 20 GB) for Backstage backend |
| `s3.tf` | S3 for TechDocs artifacts + Terraform state |
| `secrets.tf` | AWS Secrets Manager structure for GitHub token, OAuth, API keys |
| `secret-rotation.tf` | Lambda rotation triggers |
| `finops.tf` | EventBridge + Lambda for node scaling (off 8 PM UTC, on 7 AM UTC) |

### Key design decisions

**OIDC for GitHub Actions.** `iam.tf` creates an OIDC provider for `token.actions.githubusercontent.com`. The GitHub Actions role uses a trust policy that matches `repo:<org>/<repo>:ref:refs/heads/main`. No static `AWS_ACCESS_KEY_ID` ever stored in GitHub secrets.

**IRSA for pods.** Every pod that needs AWS access (Backstage → S3 for TechDocs, Crossplane → everything, External Secrets → Secrets Manager) gets an annotated ServiceAccount linked to an IAM role. `iam.tf` creates the roles; `bootstrap.sh` annotates the ServiceAccounts post-deploy.

**Terraform backend in S3.** `main.tf` configures an S3 backend with DynamoDB locking. The state bucket is created by `setup.sh` before `terraform init` runs, using the AWS CLI (bootstrap problem solved manually).

**Node scaling Lambda.** `finops.tf` deploys a Lambda that scales the node group to 0 at night and back in the morning. Saves ~$15/day on a 3-node t3.medium cluster. The Lambda name is `eks-node-scaler`.

### Terraform variables

`terraform/variables.tf` exposes: `github_org`, `aws_region`, `cluster_name`, `environment`, `node_count`, `node_instance_type`, `enable_rds`, `enable_cost_optimization`. `setup.sh` writes `terraform/terraform.tfvars` from `.idp-config.env`.

---

## 4. Phase 2 — CI/CD Golden Path (GitHub Actions)

**Files:** `.github/workflows/`

### Workflows

**`ci.yml`** — triggers on push/PR to `services/`, `helm/`, `kubernetes/`, `aws/`, `terraform/`, `backstage/app/`.

Jobs:
- `test-hello-service` — Go tests + race detector (`go test ./... -race`)
- `lint-backstage` — `yarn tsc --noEmit` + `yarn lint` in `backstage/app/`
- `validate-helm` — `helm lint helm/service-template`
- `validate-kubernetes` — `kubeconform` against schema 1.29
- `validate-terraform` — `terraform fmt -check` + `terraform validate -backend=false`
- `security-scan` — Trivy filesystem scan, Snyk SCA, SonarCloud SAST (triggered on main push)
- `lint-cli` — `go vet ./...` in `cli/`

**`build-and-deploy.yml`** — triggers on push to main for service directories.

Jobs:
1. `detect-changes` — uses `dorny/paths-filter` to produce a matrix of changed services
2. `test` — runs service-specific tests
3. `build` — multi-stage Docker build → GHCR (local path) or ECR (AWS path) depending on `DEPLOY_TARGET` secret
4. `deploy-local` — `helm upgrade --install` via kubeconfig secret
5. `deploy-aws` — ArgoCD sync or direct Helm via IRSA

**`auto-merge-onboarding.yml`** — watches PRs with title matching `feat: onboard *`. If the diff only touches `helm-values-*.yaml` files, auto-approves and merges. Requires a `GH_PAT` secret with `repo` scope. This is what makes the Backstage scaffolder flow feel instant for developers.

**`docs.yml`** — MkDocs build → GitHub Pages on changes to `docs/` or `mkdocs.yml`.

**`eval.yml`** — manual trigger for DeepEval LLM evaluation tests (pushed to `test-deepeval/` branch).

### OIDC setup (no static keys)

```yaml
permissions:
  id-token: write
  contents: read

- uses: aws-actions/configure-aws-credentials@v4
  with:
    role-to-assume: arn:aws:iam::${{ secrets.AWS_ACCOUNT_ID }}:role/github-actions-idp
    aws-region: us-east-1
```

The role ARN comes from Terraform output `github_actions_role_arn`. It's stored as a GitHub secret during `bootstrap.sh`.

---

## 5. Phase 3 — Helm Service Template

**File:** `helm/service-template/`

This is the only Helm chart in the repo. Every scaffolded service and every built-in service uses it. The pattern: service owners write `helm-values-local.yaml` and `helm-values-aws.yaml` in their `services/<name>/` directory. The chart is referenced by path locally and by ArgoCD ApplicationSet path in GitOps.

### Chart capabilities

- Deployment with configurable replicas, image, resources
- Liveness + readiness probes (HTTP GET `/health` by default, configurable)
- Service (ClusterIP) + Ingress with switchable `ingressClassName: nginx` (local) or `kubernetes.io/ingress.class: alb` (AWS)
- ServiceMonitor for Prometheus scraping (enabled by default)
- ConfigMap volume mount for app configuration
- Optional PVC for stateful workloads
- RBAC pre-wired (ServiceAccount per release)
- Labels: `app.kubernetes.io/name`, `app.kubernetes.io/version`, `team`, `cost-center` (required by Kyverno policy)

### Values override pattern

```yaml
# helm-values-local.yaml
image:
  repository: localhost:5003/my-service
  tag: latest
ingress:
  className: nginx
  host: my-service.idp.local

# helm-values-aws.yaml
image:
  repository: 123456789012.dkr.ecr.us-east-1.amazonaws.com/my-service
  tag: v1.2.3
ingress:
  className: alb
  host: my-service.idp.example.com
  annotations:
    kubernetes.io/ingress.class: alb
    alb.ingress.kubernetes.io/scheme: internet-facing
```

Helm deploy command:
```bash
helm upgrade --install my-service helm/service-template \
  --namespace services --create-namespace \
  --values services/my-service/helm-values-local.yaml --wait
```

---

## 6. Phase 4 — Backstage Developer Portal

**Files:** `backstage/app/`, `backstage/app-config*.yaml`, `backstage/Dockerfile`

### Version

Backstage v1.49.1. Multi-stage Docker image — `yarn install` and `yarn build:backend` run inside the image, not on the host. The Dockerfile base is `node:22-bookworm-slim`.

### Plugin system

Uses Backstage's new declarative frontend plugin API (`@backstage/frontend-plugin-api` v0.15+). Custom pages are registered via `createFrontendPlugin` in `backstage/app/packages/app/src/extensions.tsx`.

Critical: use `pluginId`, not `id` — the old field name causes a TypeScript error that is non-obvious.

```typescript
// CORRECT
const myPlugin = createFrontendPlugin({ pluginId: 'my-plugin', ... })

// WRONG (TS error, silent at runtime)
const myPlugin = createFrontendPlugin({ id: 'my-plugin', ... })
```

### Custom scaffolder action modules

All live in `backstage/app/packages/backend/src/modules/`. Each is a `createBackendModule` that registers a `createTemplateAction` via the `scaffolderActionsExtensionPoint`.

**CRITICAL import path:** Always import from `@backstage/plugin-scaffolder-node` (the main package), NEVER from `@backstage/plugin-scaffolder-node/alpha`. The `/alpha` export exposes `scaffolderTemplatingExtensionPoint` which is a different extension point. Using the wrong path causes the scaffolder plugin to crash at startup silently, leaving the catalog empty.

```typescript
// CORRECT
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node';

// WRONG — crashes scaffolder at startup
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node/alpha';
```

### Backend modules summary

| Module | Action ID | Lines | What it does |
|--------|-----------|-------|-------------|
| `idpLocalDeploy.ts` | `idp:deploy-local` | 417 | Helm upgrade to Kind via `host.docker.internal` |
| `idpProvisionSecret.ts` | `idp:provision-secret` | 167 | Create Kubernetes Secret or push to AWS Secrets Manager |
| `idpSetRepoSecrets.ts` | `idp:set-repo-secrets` | 183 | Write GitHub Actions secrets via GitHub API |
| `idpTechInsights.ts` | `idp:tech-insights` | 218 | Push Bronze/Silver/Gold scorecard facts to Prometheus Pushgateway |
| `idpDeployAgent.ts` | `idp:deploy-agent` | 142 | Apply KAgent Agent CRD via kubectl |
| `idpRunTrainingJob.ts` | `idp:run-training-job` | 242 | Launch Argo Workflows training job, poll to completion |
| `idpDeployMcpServer.ts` | `idp:deploy-mcp-server` | 124 | Deploy MCP server via Helm to `services-dev` namespace |
| `idpDeployModelServer.ts` | `idp:deploy-model-server` | 455 | Deploy Ollama (local) or vLLM (AWS) inference server |
| `idpRagSearch.ts` | (backend module) | 284 | Semantic search over catalog + TechDocs via Voyage AI + pgvector |
| `idpSetupContractTesting.ts` | `idp:setup-contract-testing` | 416 | Deploy contract-mcp-server, apply KAgent CRDs, auto-register contract |
| `idpDecommissionService.ts` | `idp:decommission-service` | 295 | Helm uninstall, ArgoCD app delete, git cleanup, ECR cleanup |

### Exec timeout strategy

All child process calls use `execAsync` (promisified `child_process.exec`). Timeouts are explicit to prevent the scaffolder step from hanging forever:

```typescript
const EXEC_TIMEOUT_FAST_MS   = 10_000;   // version/status checks
const EXEC_TIMEOUT_DEPLOY_MS = 120_000;  // helm upgrade (cold image pull)
const EXEC_TIMEOUT_DOCKER_MS = 180_000;  // docker pull/push
```

### Kubeconfig in Docker Compose

The `idpLocalDeploy.ts` module passes an explicit KUBECONFIG env var to every child process:

```typescript
const kubeEnv = {
  ...process.env,
  KUBECONFIG: process.env.KUBECONFIG ?? '/tmp/kubeconfig',
};
```

The kubeconfig at `/tmp/kubeconfig` is written at container startup by the docker-compose command. It rewrites the server URL from `127.0.0.1:6443` to `https://host.docker.internal:6443` and sets `insecure-skip-tls-verify: true`. This is how a container can reach the Kind API server on the host.

### Frontend pages (extensions.tsx)

All custom pages are defined in `backstage/app/packages/app/src/extensions.tsx` (~1,000+ lines):

- **FinOpsPage** — queries OpenCost at `/api/proxy/opencost/allocation/compute?window=7d&aggregate=namespace`. Shows per-namespace CPU cost, RAM cost, total cost.
- **AI Governance Scorecard** — LLM eval results, bias/fairness checks, RAG quality metrics.
- **QA KPI Dashboard** — test pass rates, execution duration, flaky test trends via Prometheus.
- **Service Metrics Explorer** — Prometheus queries (request rate, latency, error rate) per service.
- **Cost Attribution** — team/service spend via `cost_per_request_usd` metric.
- **Contract Testing Dashboard** — breaking change matrix, Pact broker integration.
- **AI Assistant Page** — native chat UI at `/ai-assistant`, talks to `idp-assistant` KAgent via proxy.

### AI Assistant implementation

The `/ai-assistant` page is a native React chat UI (not an iframe). It:
1. POSTs user message to `/api/proxy/kagent/a2a/kagent/idp-assistant`
2. Polls `/api/proxy/kagent/api/sessions/<sessionId>` for the response
3. Renders agent replies as Markdown (via `react-markdown` + `remark-gfm`)

The KAgent proxy in `app-config.local.yaml` points to `http://idp-assistant.idp.local`. The ingress (`kubernetes/kagent/ingress-idp-assistant.yaml`) is plain HTTP with `ssl-redirect: "false"` explicitly set.

### material-table / uuid patch

`@material-table/core` v3.x calls `_uuid["default"].v4()`. `uuid` v10 removed the default export, causing `TypeError: Cannot read properties of undefined (reading 'v4')` in any page that renders a table (catalog, api-docs, techdocs).

**Fix:** `.yarn/patches/@material-table-core-npm-3.2.5-*.patch` rewrites the call to `(_uuid["default"] || _uuid).v4()`. Applied automatically on `yarn install`.

Verify after any `yarn install`:
```bash
grep "uuid.*v4" backstage/app/node_modules/@material-table/core/dist/utils/data-manager.js
# Must show: (_uuid["default"] || _uuid).v4()
```

### PostgreSQL + pgvector

The local Backstage Docker Compose uses `pgvector/pgvector:pg17` not plain `postgres`. This is required for the RAG search module (`idpRagSearch.ts`) which stores embeddings in a `vector` column and uses `<=>` cosine distance queries. If you switch to plain postgres, RAG breaks silently at runtime.

### Catalog state diagnosis

```bash
# Check entity counts
docker exec backstage-postgres-1 psql -U backstage backstage_plugin_catalog \
  -c "SELECT count(*) FROM refresh_state;" \
  -c "SELECT count(*) FROM final_entities;"

# Check scaffolder logs
docker logs backstage-backstage-1 2>/dev/null | grep -E "error|scaffolder|catalog" | grep -v rootHttpRouter | tail -20
```

If `refresh_state > 0` but `final_entities = 0`: scaffolder is crashing. Check the `scaffolderActionsExtensionPoint` import path in every backend module.

---

## 7. Phase 5 — Observability Stack

**Files:** `local/observability/`, `aws/observability/`, `kubernetes/monitoring/`, `observability/`

### Prometheus + Grafana (local)

Deployed via `kube-prometheus-stack` Helm chart. Local values in `local/observability/prometheus-values-local.yaml`. Key overrides:
- Grafana enabled, admin password `admin`, ingress `grafana.idp.local`
- Prometheus retention 7d, storage 10Gi
- Alertmanager enabled
- ServiceMonitor selector: matches all namespaces

Installed by `bootstrap-local.sh` unless `--skip-obs` flag is passed.

### Prometheus + Grafana (AWS)

Values in `aws/observability/prometheus-stack-aws-values.yaml`. Differences:
- ALB ingress for Grafana
- CloudWatch agent sidecar for cost metrics
- Longer retention (30d)
- PersistentVolumeClaim on EBS gp3

### DORA metrics exporter

A CronJob in the `monitoring` namespace that runs every 15 minutes. It queries the GitHub API for:
- Deployment frequency (recent releases per day)
- Lead time for changes (PR open → merge time)
- Change failure rate (% of deployments that rolled back)
- MTTR (time from incident issue open → close)

Pushes results to Prometheus Pushgateway as `dora_deployment_frequency`, `dora_lead_time_seconds`, `dora_change_failure_rate`, `dora_mttr_seconds`.

Source: `local/observability/dora-exporter-local.yaml` (local), `aws/observability/dora-exporter.yaml` (AWS).

### Catalog exporter CronJob

`scripts/apply-catalog-exporter.sh` deploys a CronJob that:
1. Queries Backstage catalog API (`/api/catalog/entities`)
2. Groups by `kind` (Component, API, Resource, Template)
3. Pushes `backstage_catalog_entities_total{kind="..."}` to Pushgateway
4. Pushes per-component info metric `backstage_catalog_service_info`

Force a manual run:
```bash
kubectl create job catalog-exporter-now --from=cronjob/catalog-exporter -n monitoring
```

### Tech Insights scorecard

The `idpTechInsights.ts` action pushes per-service scorecard facts to Pushgateway as a Prometheus gauge. The scorecard has three tiers:

| Tier | Gates |
|------|-------|
| Bronze | Has TechDocs, has owner annotation, has health check endpoint |
| Silver | Bronze + has CI pipeline, has tests, has Prometheus metrics |
| Gold | Silver + has contract tests, has DAST scan, has SLO defined |

Displayed on each service's entity page in Backstage via a custom entity tab.

### Grafana dashboards

All dashboards are committed as ConfigMaps in `kubernetes/monitoring/`:

- `grafana-qa-dashboard-configmap.yaml` — test pass rates, execution time, flaky test trends
- `grafana-ai-dashboard-configmap.yaml` — LLM eval, bias checks, RAG quality, MCP tool call rates
- `grafana-dora-dashboard-configmap.yaml` — deployment frequency, lead time, MTTR, change failure rate

Dashboards use the `grafana-sidecar` pattern: Grafana watches for ConfigMaps with label `grafana_dashboard: "1"` and imports them automatically.

### Pushgateway

Deployed as part of the observability stack. Used by:
- DORA exporter
- Catalog exporter
- Tech Insights (`idp:tech-insights` action)
- `seed-qa-metrics.sh` (demo seed data)

Available at `http://pushgateway.idp.local`.

---

## 8. Phase 6 — hello-service Reference Implementation

**Files:** `services/hello-service/`

### What it is

A minimal Go HTTP server that demonstrates the full platform lifecycle:
- Multi-stage Dockerfile (build → run, ~15 MB final image)
- `/health` endpoint (returns `{"status":"ok"}`)
- `/metrics` endpoint (Prometheus exposition format)
- Full GitHub Actions CI (`services/hello-service/.github/workflows/ci.yml`)
- Backstage catalog entity (`catalog-info.yaml`)
- TechDocs (`docs/`, `mkdocs.yml`)
- Crossplane resource claims (`claims/`) — DynamoDB, S3, RDS examples

### Go module

`services/hello-service/go.mod` is a separate Go module. CI covers it with `go test ./... -coverprofile=coverage.out -covermode=atomic`. The `cli/` module is also separate — changes there do NOT trigger CI.

### Tests

```bash
cd services/hello-service
go test ./...
go test -run TestHandlerName ./...
```

### TechDocs

`services/hello-service/docs/` contains `index.md` with a full service description. `mkdocs.yml` references it. Backstage renders it via `techdocs-backend`. For local development TechDocs renders from the bind-mounted catalog directory. For AWS it uses S3 storage.

---

## 9. Phase 7 — Local Deployment Action (idp:deploy-local)

**File:** `backstage/app/packages/backend/src/modules/idpLocalDeploy.ts`

### The problem this solves

Backstage runs in Docker Compose. The Kind cluster runs on the host. A Docker container cannot reach `127.0.0.1:6443` (the host's Kind API server). Solution: rewrite the kubeconfig server URL to `host.docker.internal:6443` at container startup.

### How it works

1. `local/backstage/docker-compose.yml` runs a startup command that reads the K8s credentials written by `scripts/get-k8s-credentials.sh` and generates `/tmp/kubeconfig` inside the Backstage container with:
   - `server: https://host.docker.internal:6443`
   - `insecure-skip-tls-verify: true`

2. The `idpLocalDeploy.ts` module reads `KUBECONFIG=/tmp/kubeconfig` and runs:
   ```bash
   helm upgrade --install <serviceName> /helm/service-template \
     --namespace <namespace> --create-namespace \
     --set image.repository=<registry>/<serviceName> \
     --set image.tag=<imageTag> \
     --wait --timeout 2m
   ```

3. The Helm chart path inside the container is `/helm/service-template` — it's volume-mounted from `../../helm/service-template` in docker-compose.

### Deploy-to-Kind standalone template

`backstage/catalog/templates/deploy-to-kind/` is a Backstage template that surfaces this action to developers. It lets them deploy any existing image to Kind with a form UI — no CLI needed.

---

## 10. Phase 8 — GitOps with ArgoCD

**Files:** `local/argocd/`, `aws/argocd/`, `kubernetes/argocd/`

### App-of-apps pattern

ArgoCD is bootstrapped with a root Application that points to an app-of-apps directory:
- Local: `local/argocd/app-of-apps-local.yaml`
- AWS: `aws/argocd/app-of-apps.yaml`

The root app syncs an ApplicationSet that auto-discovers services.

### ApplicationSet discovery

```yaml
# kubernetes/argocd/applicationset.yaml
spec:
  generators:
    - git:
        repoURL: https://github.com/<org>/backstage-platform-template
        revision: main
        directories:
          - path: services/*
          - path: services/contract-mcp-server     # EXCLUDED
            exclude: true
```

Any directory under `services/` that contains a `helm-values-local.yaml` (or `helm-values-aws.yaml`) gets an ArgoCD Application automatically. No manual registration needed.

### contract-mcp-server exclusion

`contract-mcp-server` is intentionally excluded from the ApplicationSet in both `local/argocd/app-of-apps-local.yaml` and `aws/argocd/app-of-apps.yaml`. It's a platform-internal tool deployed only by `bootstrap-ai.sh`, not exposed to end users via GitOps. Do not remove this exclusion.

### ArgoCD credential setup

`bootstrap-local.sh --install-argocd` patches the ArgoCD `argocd-cm` ConfigMap with the GitHub Personal Access Token for private repo access:
```bash
kubectl create secret generic argocd-repo-creds \
  --from-literal=url=https://github.com/<org> \
  --from-literal=username=git \
  --from-literal=password=$GITHUB_TOKEN \
  -n argocd
```

### Auto-merge onboarding PRs

When the Backstage scaffolder creates a new service, it opens a PR with only `helm-values-*.yaml` changes. The `auto-merge-onboarding.yml` workflow auto-approves and merges these if the title matches `feat: onboard *`. ArgoCD then picks up the new service directory automatically.

---

## 11. Phase 9 — CD Pipeline (ECR → EKS)

**File:** `.github/workflows/build-and-deploy.yml`

### Change detection

Uses `dorny/paths-filter` to detect which services changed:
```yaml
- uses: dorny/paths-filter@v3
  with:
    filters: |
      hello-service:
        - 'services/hello-service/**'
      idp-mcp-server:
        - 'services/idp-mcp-server/**'
```

This produces a matrix so only changed services rebuild.

### Build flow

1. `docker buildx build` with `--platform linux/amd64`
2. Login to ECR: `aws ecr get-login-password | docker login`
3. Tag: `<account>.dkr.ecr.<region>.amazonaws.com/<service>:<git-sha>`
4. Push to ECR
5. Also tag and push `:latest`

### Deploy flow

Option A (ArgoCD): Update `image.tag` in `helm-values-aws.yaml` and commit. ArgoCD reconciles automatically (sync policy: `automated`).

Option B (direct Helm): `helm upgrade --install` via kubeconfig from a GitHub Actions secret.

### Local registry

For local Kind deployments the registry is `localhost:5003`. Kind is configured in `local/kind-config.yaml` to use this as a containerd mirror:
```yaml
containerdConfigPatches:
  - |
    [plugins."io.containerd.grpc.v1.cri".registry.mirrors."localhost:5003"]
      endpoint = ["http://localhost:5003"]
```

The registry is a plain `registry:2` Docker container started by `bootstrap-local.sh`.

---

## 12. Phase 10 — Policy Enforcement

**Files:** `kubernetes/policies/`

### OPA/Gatekeeper (AWS)

Applied by `bootstrap.sh`. Policies are ConstraintTemplates + Constraints:

| Policy | What it blocks |
|--------|----------------|
| `require-health-probes` | Deployments without liveness + readiness probes |
| `require-labels` | Pods without `app`, `team`, `cost-center` labels |
| `require-resource-limits` | Containers without CPU + memory limits |
| `deny-latest-tag` | Images tagged `:latest` (forces explicit version) |
| `require-cost-tags` | Namespaces without `cost-center` label |

### Kyverno (local Kind)

Same policies implemented as Kyverno ClusterPolicies for local development. Kyverno is lighter than Gatekeeper for local use. The policies mirror the OPA ones 1:1.

### Team namespace isolation

`kubernetes/teams/` contains example team namespaces with:
- Namespace definition
- NetworkPolicy (deny ingress from other teams, allow from monitoring)
- ResourceQuota
- LimitRange
- RoleBinding for team members

---

## 13. Phase 11 — Crossplane Self-Service Resources

**Files:** `aws/crossplane/`, `backstage/catalog/templates/*-crossplane/`

### Architecture

Crossplane runs in `crossplane-system` namespace. The AWS provider uses IRSA (role created by `terraform/iam-crossplane.tf`). XRDs and Compositions are in `aws/crossplane/`.

### Resources available via Crossplane

| Template | Claim kind | AWS resource |
|----------|-----------|-------------|
| `s3-bucket-crossplane` | XBucket | S3 bucket |
| `rds-database-crossplane` | XDatabase | RDS PostgreSQL instance |
| `dynamodb-table-crossplane` | XDynamoTable | DynamoDB table |
| `sqs-queue-crossplane` | XQueue | SQS queue |
| `kafka-topic-crossplane` | XKafkaTopic | MSK topic |

### How it works

1. Developer opens Backstage template → fills form (bucket name, region, team)
2. Backstage scaffolder writes a Claim YAML to `services/<service-name>/claims/<resource>.yaml`
3. PR is opened and auto-merged
4. ArgoCD ApplicationSet picks up the new file
5. Crossplane sees the Claim, creates a Composite Resource, provisions the AWS resource
6. Crossplane writes connection details to a Secret in the service namespace

### Terraform vs Crossplane decision

- **Use Terraform** for resources shared across services (VPC, RDS for Backstage, ECR). Terraform is applied once by the platform team from outside the cluster.
- **Use Crossplane** for per-service resources requested through Backstage. The reconciliation loop in Crossplane handles drift automatically without re-running Terraform.

See `docs/crossplane-vs-terraform.md` for the full decision matrix.

---

## 14. Phase 12 — AI/ML Platform (KAgent + MLflow + MCP Servers)

**Files:** `scripts/bootstrap-ai.sh`, `kubernetes/kagent/`, `services/idp-mcp-server/`, `services/qa-mcp-server/`, `services/contract-mcp-server/`, `local/kagent/`, `aws/kagent/`

### KAgent

KAgent is a Kubernetes-native AI agent framework. It provides:
- `Agent` CRD — defines an AI agent with system prompt, model, and tool bindings
- `ModelConfig` CRD — configures an LLM provider (Anthropic, OpenAI)
- `RemoteMCPServer` CRD — registers an MCP server for an agent to use

KAgent controller runs in the `kagent` namespace. It reconciles Agent CRDs, calls `tools/list` on each bound MCP server at startup, and exposes an A2A (Agent-to-Agent) HTTP API.

### Model configuration

```yaml
# kubernetes/kagent/modelconfig-claude.yaml
apiVersion: kagent.dev/v1alpha2
kind: ModelConfig
metadata:
  name: claude-anthropic
  namespace: kagent
spec:
  provider: Anthropic
  model: claude-haiku-4-5-20251001
  apiKeySecretRef:
    name: anthropic-api-key
    key: ANTHROPIC_API_KEY
```

The Anthropic API key flows from `local/.env` → Kubernetes Secret → ModelConfig ref. For AWS it flows through External Secrets Operator from AWS Secrets Manager.

### Three agents

**idp-assistant** (`kubernetes/kagent/idp-agent.yaml`)
- Tools: `catalog_search`, `get_service_metrics`, `get_template_params`, `scaffold_service`, `list_deployments`, `list_templates`
- System prompt enforces: never guess tool results, no interactive dialogs, execute scaffold flow in one turn
- Exposed via ingress at `http://idp-assistant.idp.local`

**qa-assistant** (`kubernetes/kagent/qa-agent.yaml`)
- Tools: from `qa-mcp-server` — list test suites, scaffold test suite, get test metrics, search test catalog
- Exposed via kagent UI (not a standalone ingress)

**contract-assistant** (`kubernetes/kagent/contract-agent.yaml`)
- Tools: all 9 from `contract-mcp-server` + `catalog_search` and `list_deployments` from `idp-mcp-server`
- Used via the AI assistant page or directly via A2A API

### MCP servers

All three MCP servers use the **StreamableHTTP transport** (not stdio). They run as Kubernetes Deployments in `services-dev` namespace and are registered as `RemoteMCPServer` resources in the `kagent` namespace.

**idp-mcp-server** (`services/idp-mcp-server/`)
- Port: 3001
- 6 tools: `catalog_search`, `get_service_metrics`, `get_template_params`, `scaffold_service`, `list_deployments`, `list_templates`
- Talks to Backstage API (env: `BACKSTAGE_URL`, `BACKSTAGE_TOKEN`)
- Talks to Prometheus API (env: `PROMETHEUS_URL`)
- Talks to K8s API (env: `K8S_API`, `K8S_TOKEN`, `K8S_CLUSTER_CA_B64`)
- Emits metrics: `mcp_tool_calls_total`, `mcp_tool_duration_seconds`, `ai_api_calls_total`

**qa-mcp-server** (`services/qa-mcp-server/`)
- Port: 3002
- 4 tools: `list_test_suites`, `scaffold_test_suite`, `search_test_catalog`, `get_test_metrics`
- Same Backstage + Prometheus integration as idp-mcp-server

**contract-mcp-server** (`services/contract-mcp-server/`)
- Port: 3003
- 9 tools: `fetch_service_contract`, `auto_discover_contracts`, `register_contract`, `get_contract`, `list_contracts`, `generate_contract_tests`, `validate_compatibility`, `detect_breaking_changes`, `get_compatibility_report`
- Stores contracts in memory + optional ConfigMap persistence
- Excluded from the ArgoCD ApplicationSet — deployed only by `bootstrap-ai.sh`

### MCP server GitOps coverage

| Service | Deployed by | ApplicationSet | Requires bootstrap-ai.sh |
|---------|------------|----------------|--------------------------|
| `hello-service` | ArgoCD auto | Yes | No |
| `idp-mcp-server` | ArgoCD auto + Helm fallback | Yes | No |
| `qa-mcp-server` | ArgoCD auto + Helm fallback | Yes | No |
| `contract-mcp-server` | bootstrap-ai.sh only | **No (excluded)** | Yes |

`bootstrap-ai.sh` falls back to direct Helm if the ArgoCD application is missing:
```bash
helm upgrade --install idp-mcp-server helm/service-template \
  --namespace services-dev --create-namespace \
  --values services/idp-mcp-server/helm-values-local.yaml --wait
```

### MLflow

MLflow tracking server deployed to `ml-platform` namespace.
- Local: uses MinIO (deployed as a sidecar) for artifact storage
- AWS: uses S3 backend (bucket created by Terraform)
- UI at `http://mlflow.idp.local`

MLflow integration: `idpRunTrainingJob.ts` submits an Argo Workflows training job that logs experiments to MLflow via `MLFLOW_TRACKING_URI`.

### RAG search

`idpRagSearch.ts` implements semantic search over Backstage catalog + TechDocs:
1. User query → Voyage AI embedding API (`VOYAGE_API_KEY` in env)
2. `<=>` cosine distance query on `vector` column in `backstage_plugin_rag` PostgreSQL schema
3. Returns top-K results with entity metadata

The pgvector extension must be enabled on the PostgreSQL instance. Local: `pgvector/pgvector:pg17` image in docker-compose. AWS: `pgvector` extension enabled on RDS PostgreSQL 15.

### AI cost attribution

Each MCP server pushes `ai_api_calls_total{service="...", team="...", model="..."}` to Prometheus. The Grafana AI dashboard aggregates this per team. KAgent pods carry `team: platform` label for cost tracking. The `require-cost-tags` Kyverno policy enforces this label.

### bootstrap-ai.sh installation sequence

```
1. Create kagent namespace
2. Install KAgent controller (Helm)
3. Create ModelConfig CRD (claude-anthropic)
4. Deploy MLflow (optional, skip with --skip-mlflow)
5. Deploy idp-mcp-server (Helm → services-dev)
6. Deploy qa-mcp-server (Helm → services-dev)
7. Deploy contract-mcp-server (Helm → services-dev)
8. Register RemoteMCPServer CRDs (idp-toolserver, qa-toolserver, contract-toolserver)
9. Apply idp-assistant Agent CRD
10. Apply qa-assistant Agent CRD
11. Apply contract-assistant Agent CRD
12. Add /etc/hosts entries (idp-assistant.idp.local, mlflow.idp.local, etc.)
```

---

## 15. Phase 13 — QA Templates & Shift-Left Program

**Files:** `backstage/catalog/templates/`, `test-suites/`

### Test pyramid coverage

| Layer | Template | Tech |
|-------|---------|------|
| Unit | `unit-test-suite` | Jest/Pytest/Go test |
| Component | `component-test-suite` | WireMock stubs |
| Integration | `testcontainers-suite` | Testcontainers (Docker-based Postgres/Kafka) |
| Contract (provider) | `enable-contract-testing` | MCP-driven + OpenAPI |
| Contract (consumer) | `pact-contract-suite` | Pact consumer tests |
| E2E | `playwright-e2e-suite` | Playwright TypeScript |
| API | `newman-api-suite` | Newman (Postman collections) |
| Performance | `k6-performance-suite` | k6 JavaScript DSL |
| Security DAST | `zap-dast-suite` | OWASP ZAP |
| Visual | `visual-regression-suite` | Playwright screenshots |
| Accessibility | `accessibility-suite` | axe-core |
| Mobile | `appium-mobile-suite` | Appium + WebdriverIO |
| Chaos | `chaos-mesh-suite` | Chaos Mesh |
| LLM eval | `deepeval-llm-eval-suite` | DeepEval + Ragas |
| Mutation | `mutation-testing-suite` | Stryker |
| Synthetic monitoring | `datadog-synthetic-suite` | Datadog API |
| IaC | `iac-test-suite` | tflint + Checkov + Terratest |

### Two scaffold modes

Each test template supports two modes:

**New repo mode** — uses `skeleton/` directory. Creates a standalone test repository on GitHub.

**Add to existing repo mode** — uses `skeleton-addon/` (or `skeleton-<lang>/`). Opens a PR against the target service's repository adding tests to `test-suites/<name>/`. This is the preferred mode for unit/component/IaC tests that must live in the service repo.

### enable-contract-testing template

This is the most complex template. `idpSetupContractTesting.ts` does:
1. Deploy `contract-mcp-server` via Helm (writes values to a temp file, `helm upgrade --install`)
2. Apply KAgent CRDs via `kubectl apply`
3. Wait for `contract-mcp-server` health check (`/healthz` returns 200)
4. Call `fetch_service_contract` tool — this POSTs to the MCP server, which hits the target service's `/openapi.json` endpoint and registers the spec

JSON Schema type errors in this module (and all action modules) are pre-existing and harmless — esbuild transpiles without type checking.

### enable-security-scanning template

`backstage/catalog/templates/enable-security-scanning/` opens a PR that adds to the existing service CI:
- Trivy image + filesystem scan
- Snyk SCA (`snyk test`)
- SonarCloud SAST (`sonar-scanner`)

Requires `SNYK_TOKEN`, `SONAR_TOKEN` GitHub secrets. The template adds these secrets via `idp:set-repo-secrets` action.

### Shift-left scorecard (Bronze/Silver/Gold)

The `idpTechInsights.ts` action evaluates and reports:

**Bronze** (hygiene baseline):
- `catalog-info.yaml` exists and has `spec.owner`
- TechDocs `docs/index.md` exists
- Health check endpoint responds

**Silver** (CI quality):
- GitHub Actions CI workflow exists
- Test files found in repo
- Service pushes metrics (Prometheus endpoint reachable)

**Gold** (advanced quality):
- Contract tests registered (OpenAPI spec in contract-mcp-server)
- DAST scan in CI (`zap-` job in workflow)
- SLO defined (`kubernetes/monitoring/slo-*.yaml`)

Results are pushed to Pushgateway and visualized in the Grafana QA dashboard.

---

## 16. Bootstrap Scripts & Operational Runbook

**Files:** `scripts/`

### Script dependency graph

```
setup.sh  (entry point — runs once)
  ├─ sources scripts/lib.sh
  ├─ personalizes placeholders via placeholders.conf
  └─ calls → bootstrap-local.sh  OR  bootstrap.sh

bootstrap-local.sh  (local Kind)
  ├─ sources scripts/lib.sh
  ├─ Phase 1: Kind cluster + local registry
  ├─ Phase 2: nginx ingress controller
  ├─ Phase 3: Prometheus + Grafana (unless --skip-obs)
  ├─ Phase 4: ArgoCD + app-of-apps (unless --skip-gitops)
  ├─ Phase 5: OPA/Gatekeeper (unless --skip-policies)
  ├─ Phase 6: DORA exporter CronJob
  ├─ Phase 7: K8s credentials (scripts/get-k8s-credentials.sh)
  ├─ Phase 8: Catalog exporter CronJob
  └─ Phase 9: Backstage docker-compose (with --full or --start-backstage)

bootstrap.sh  (AWS EKS)
  ├─ sources scripts/lib.sh
  ├─ Phase 1: terraform init + apply
  ├─ Phase 2: kubectl config + RBAC
  ├─ Phase 3: External Secrets Operator + ClusterSecretStore
  ├─ Phase 4: DORA exporter CronJob
  ├─ Phase 5: ArgoCD + app-of-apps
  ├─ Phase 6: OPA/Gatekeeper
  ├─ Phase 7: Crossplane
  ├─ Phase 8: Backstage K8s deployment
  └─ Phase 9: hello-service build → ECR → ArgoCD deploy

bootstrap-ai.sh  (AI/ML stack — optional, both envs)
  ├─ sources scripts/lib.sh
  ├─ KAgent controller
  ├─ MLflow (unless --skip-mlflow)
  ├─ 3× MCP servers
  └─ KAgent agents + RemoteMCPServer CRDs

Day-2 standalone scripts (fully independent):
  ├─ validate-deployment.sh   — 50+ health checks
  ├─ verify-secrets.sh        — pre-flight credential check
  ├─ apply-catalog-exporter.sh — redeploy metrics CronJob
  ├─ get-k8s-credentials.sh   — refresh Backstage K8s SA token
  ├─ seed-qa-metrics.sh       — seed Grafana with sample QA data
  ├─ cleanup.sh               — ordered AWS teardown
  └─ cleanup-helm-repos.sh    — housekeeping
```

### Placeholder substitution system

`setup.sh` does a one-time find-and-replace:
- `moatazeldebsy` → your GitHub org
- `123456789012` → your AWS account ID
- `us-east-1` → your AWS region
- `idp-mvp` → your cluster name

The list of files to update is in `scripts/placeholders.conf` (manifest-driven, not regex-scanned). After substitution, `.idp-config.env` is written and every bootstrap script re-reads it via `load_idp_config()` from `lib.sh`.

This allows day-2 reruns to stay consistent: `bootstrap-local.sh --install-argocd` reads the same org/cluster config as the original run.

### Local destroy sequence

`bootstrap-local.sh --destroy` runs in this order (while cluster is up):

1. AI/ML teardown — calls `bootstrap-ai.sh --destroy`
2. Scaffolded service cleanup (`_cleanup_scaffolded_services` in `lib.sh`):
   - Auto-discovers every `services/*/` that is NOT in the built-in list
   - Built-ins never touched: `hello-service`, `idp-mcp-server`, `qa-mcp-server`, `contract-mcp-server`
   - For each scaffolded service: deletes ArgoCD Application (cascade), uninstalls Helm, removes `services/<name>/`, commits + pushes `[skip ci]`
3. `kind delete cluster` (or Rancher Desktop namespace delete)
4. `docker compose down` + image/volume prune
5. `/etc/hosts` entries removed

**Not cleaned up (intentional):** `kubernetes/teams/<name>/` (team structure, reusable), GitHub repos of scaffolded services (external), `test-suites/` (pre-committed demo content).

### AWS destroy sequence (8 phases)

`cleanup.sh --cluster-name idp-mvp --force`:

| Phase | What |
|-------|------|
| 1 | Delete ALBs / Classic ELBs (K8s-managed, block VPC deletion) |
| 2 | Disable RDS deletion protection |
| 3 | Delete Crossplane-tagged resources (S3, RDS, DynamoDB, SQS tagged `idp:provisioner=crossplane`) |
| 4 | Empty Terraform-managed S3 buckets + ECR repos |
| 4.5 | Scaffolded service cleanup (same logic as local) |
| 5 | `terraform destroy` |
| 6 | Delete CloudWatch log groups |
| 7 | Verify all resources gone |

### Key day-2 commands

```bash
# Rebuild Backstage after code changes
docker compose -f local/backstage/docker-compose.yml build backstage
docker compose -f local/backstage/docker-compose.yml up -d

# Config-only change (no rebuild)
docker compose -f local/backstage/docker-compose.yml restart backstage

# Refresh K8s credentials for Backstage
./scripts/get-k8s-credentials.sh

# Repair ArgoCD + re-register GitHub creds
./scripts/bootstrap-local.sh --install-argocd

# Repair Pushgateway + seed QA metrics
./scripts/bootstrap-local.sh --install-pushgateway

# Install Argo Workflows
./scripts/bootstrap-local.sh --install-argo-workflows

# Print all URLs without bootstrapping
./scripts/bootstrap-local.sh --print-urls

# Redeploy a single MCP server
helm upgrade --install idp-mcp-server helm/service-template \
  --namespace services-dev --create-namespace \
  --values services/idp-mcp-server/helm-values-local.yaml --wait

# Force-restart KAgent controller (clears stale conditions)
kubectl rollout restart deployment/kagent-controller -n kagent

# Check KAgent agent status
kubectl get agents -n kagent
kubectl describe agent idp-assistant -n kagent
kubectl logs -n kagent deployment/kagent-controller --tail=30 | grep -E "error|registered"
```

---

## 17. Key Design Decisions & Hard-Won Gotchas

### scaffolderActionsExtensionPoint import (catalog goes empty)

The most subtle production-breaking bug in this repo. When a backend module imports from `/alpha`, the scaffolder crashes silently on startup. ArgoCD syncs, pods run, but `final_entities` in the catalog DB stays 0. Nothing obvious in logs unless you grep for `scaffolder`.

```typescript
// MUST be this path
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node';
```

Diagnosis: check `final_entities` count in DB. If it's 0 with `refresh_state > 0`, it's this bug.

### host.docker.internal for local Kind deploys

Backstage runs in Docker Compose. Kind runs on the host. The Kind API server is at `127.0.0.1:6443` from the host perspective. From inside a Docker container, that's not reachable. The solution is:

1. `get-k8s-credentials.sh` creates a ServiceAccount with `cluster-admin` rolebinding
2. It writes a token to `local/backstage/.env` as `K8S_SERVICE_ACCOUNT_TOKEN`
3. At Backstage container startup, docker-compose generates `/tmp/kubeconfig` with `server: https://host.docker.internal:6443` and `insecure-skip-tls-verify: true`
4. All `kubectl` and `helm` calls in scaffolder actions use `KUBECONFIG=/tmp/kubeconfig`

### KAgent SSL redirect = false (ingresses)

KAgent agents communicate over HTTP internally. The nginx ingress controller defaults to SSL redirect. Without explicitly disabling this, HTTP traffic to KAgent ingresses gets redirected to HTTPS which doesn't exist locally → 308 loop.

```yaml
# kubernetes/kagent/ingress-idp-assistant.yaml
annotations:
  nginx.ingress.kubernetes.io/ssl-redirect: "false"
```

Both the UI ingress (`kubernetes/kagent/ingress.yaml`) and the A2A ingress (`ingress-idp-assistant.yaml`) need this annotation.

### material-table / uuid v10 incompatibility

`@material-table/core` v3.x calls `uuid` via `_uuid["default"].v4()`. `uuid` v10 removed the default export. This breaks any Backstage page that renders a data table. The fix is a yarn patch in `.yarn/patches/`. If it disappears after a `yarn upgrade`, re-apply:

```bash
cd backstage/app && yarn install
# verify
grep "uuid.*v4" node_modules/@material-table/core/dist/utils/data-manager.js
```

### pgvector vs plain postgres

The local docker-compose must use `pgvector/pgvector:pg17`, not `postgres:17`. The RAG search module creates a `vector` column and uses `<->` / `<=>` operators from the pgvector extension. Plain postgres does not have this extension and fails at migration time with a cryptic error.

### Rancher Desktop prerequisites

If using Rancher Desktop instead of Kind:
1. **Disable Traefik** in Preferences → Kubernetes (Traefik conflicts with nginx ingress on port 80/443)
2. **Set container engine to dockerd** (not containerd) in Preferences → Container Engine
3. Set `KUBERNETES_PROVIDER=rancher-desktop` in `local/.env`

If Traefik is not disabled first, nginx ingress will fail to bind port 80 and all `*.idp.local` hostnames will be unreachable.

### Kind inotify limits on macOS

Kind on macOS hits low inotify limits inside Docker. This causes random pod evictions or API server instability on larger clusters. `scripts/install-inotify-launchdaemon.sh` installs a macOS LaunchDaemon that raises the sysctl inside Docker at boot. Run it once, then restart Docker Desktop.

### ArgoCD v3 + Helm 4 breaking changes

ArgoCD v3.4 (chart 9.5.13) supports Helm 4. Helm 4 changed how empty values are handled in `--set` flags. If you see ArgoCD sync failures with empty string errors, check that `helm-values-*.yaml` files don't rely on empty `--set` flag behavior from Helm 3.

### Backstage backend auth (dangerouslyDisableDefaultAuthPolicy)

`app-config.local.yaml` has:
```yaml
backend:
  auth:
    dangerouslyDisableDefaultAuthPolicy: true
```

This prevents a 401 flash that happens before the guest auth provider completes its initial handshake. Without it, the page loads → API calls fail with 401 → UI shows error → auth completes → page works. With it, API calls succeed immediately. This is safe for local development. Do NOT enable this in AWS.

### Backstage port difference

- Local Docker Compose: port `3000` (mapped in docker-compose.yml)
- AWS EKS: port `7007` (Backstage's default backend port)

`app-config.local.yaml` overrides `backend.listen.port: 3000`. `app-config.aws.yaml` uses the default `7007`.

### contract-mcp-server excluded from ApplicationSet

The exclusion rule exists in BOTH app-of-apps files:
- `local/argocd/app-of-apps-local.yaml`
- `aws/argocd/app-of-apps.yaml`

If you remove it from one, ArgoCD will try to deploy contract-mcp-server without the required AI stack and fail. Always update both files together.

### KAgent tool "No description available"

If a KAgent agent's tool list shows "No description available" in the UI, it means the tool name in the agent's `toolNames` list doesn't match any tool exposed by the bound MCP server. The controller calls `tools/list` on startup and silently shows this for missing tools. Fix: check `kubectl describe agent <name> -n kagent` conditions and verify the tool name exactly matches what the MCP server exposes.

### Backstage Kubernetes page (standalone) disabled

`app-config.local.yaml` disables the standalone Kubernetes page:
```yaml
app:
  extensions:
    - page:kubernetes:
        disabled: true
```

The entity-tab Kubernetes view still works. The standalone page breaks because it tries to list clusters across all namespaces which requires a cluster-scoped ClusterRole that is not safe to grant broadly. The entity tab only shows pods/deployments for the specific service, which is safe.

---

## 18. Component Versions

| Component | Version | Notes |
|-----------|---------|-------|
| Backstage | v1.49.1 | Full monorepo, multi-stage Docker build |
| Kubernetes (EKS) | 1.29 | Managed node groups, VPC CNI, EBS CSI driver |
| Kubernetes (Kind) | 1.33.1 | Local development, `kind v0.27+` required |
| ArgoCD | v3.4 (chart 9.5.13) | App-of-apps pattern |
| Helm | 3.x / 4.x | Both supported |
| Terraform | ≥ 1.5 | S3 backend, DynamoDB state lock |
| Go (hello-service, CLI) | 1.26 | Separate go.mod per module |
| Node.js (MCP servers, Backstage) | 24 LTS | |
| kube-prometheus-stack | 61.x | Includes Prometheus, Grafana, Alertmanager |
| KAgent | 0.5.x | Kubernetes-native agent framework |
| MLflow | 2.x | Tracking server |
| Crossplane | 1.x | AWS Provider |
| External Secrets Operator | 0.9.x | |
| nginx ingress | 4.x | Local only |
| AWS Load Balancer Controller | 2.7.x | AWS only |
| PostgreSQL | 17 (pgvector image) | pgvector extension for RAG |
| Claude model | claude-haiku-4-5-20251001 | KAgent default |

---

*End of internal reference. Last updated: 2026-05-30.*
