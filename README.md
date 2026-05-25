# backstage-platform-template

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/moatazeldebsy/backstage-platform-template/actions/workflows/ci.yml/badge.svg)](https://github.com/moatazeldebsy/backstage-platform-template/actions/workflows/ci.yml)
[![Docs](https://img.shields.io/badge/docs-GitHub%20Pages-blue)](https://moatazeldebsy.github.io/backstage-platform-template/)
[![GitHub stars](https://img.shields.io/github/stars/moatazeldebsy/backstage-platform-template?style=flat)](https://github.com/moatazeldebsy/backstage-platform-template/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/moatazeldebsy/backstage-platform-template?style=flat)](https://github.com/moatazeldebsy/backstage-platform-template/network/members)
[![Use this template](https://img.shields.io/badge/Use%20this%20template-2ea44f?logo=github)](https://github.com/moatazeldebsy/backstage-platform-template/generate)

**A production-ready Internal Developer Platform template** — Backstage developer portal, golden-path Helm chart, 12 software templates + 14 QA/test scaffold templates + 5 Crossplane Claim templates, AI/ML platform (KAgent + MLflow + 3 MCP servers), shift-left quality programme (Bronze/Silver/Gold scorecard + contract testing), Prometheus + Grafana observability, AWS EKS via Terraform, and per-service cloud resources via Crossplane. Runs locally on Kind in ~15 minutes.

> **Using this template?** Click **"Use this template"** above, then run `./scripts/setup.sh` to personalise all placeholders for your org.

> **First time?** Always run `./scripts/setup.sh` first. It replaces `moatazeldebsy` and other placeholders across all config files. If you skip this step, ArgoCD will generate no apps because its ApplicationSet still has the unresolved `moatazeldebsy` placeholder.

<!-- demo-gif: replace the image below with an animated GIF showing the golden path
     (scaffold service in Backstage → CI runs → service live with metrics).
     Suggested tool: peek, kooha, or asciinema + svg-term.
     Host in docs/assets/demo.gif and update the path below. -->
> **Golden path in 60 seconds:** scaffold a service → CI runs tests + builds image → ArgoCD deploys to Kind → Backstage shows health + metrics.

## Compatibility

| Component | Tested version |
|-----------|---------------|
| Backstage | v1.49.1 |
| Kubernetes | 1.29 (EKS), 1.33.1 (Kind) |
| Helm | 3.x / 4.x |
| Kind | ≥ 0.27 |
| ArgoCD | v3.4 (chart 9.5.13) |
| Terraform | ≥ 1.5 |
| Go (hello-service) | 1.26 |
| Node.js (Backstage) | 24 LTS |

---

## What You Get

| Capability | Details |
|---|---|
| **Developer portal** | Backstage v1.49.1 with catalog, TechDocs, and custom scaffolder actions |
| **Software templates** | 12 golden-path service templates (Node.js, Python, Go, React, Terraform, Deploy-to-Kind, Team namespace, RDS, Add-secret, AI Agent, ML Experiment, MCP Server) |
| **QA / test templates** | 14 testing scaffold templates — Playwright E2E, k6 Performance, Pact Contract, Newman API, ZAP DAST, Datadog Synthetic, Visual Regression, Accessibility (axe), BDD Cucumber, Appium Mobile, Chaos Mesh, Stryker Mutation, Testcontainers Integration, DeepEval LLM Eval — plus `enable-contract-testing` for MCP-driven contract gates |
| **Golden-path chart** | Single reusable Helm chart for all services — health checks, metrics, RBAC pre-wired |
| **Shift-left quality** | Bronze/Silver/Gold scorecard (11 checks, visible in Backstage Tech Insights + Grafana); PR gates for coverage ≥70%, vuln scan, static analysis; ArgoCD PreSync contract gate blocks breaking API changes. See [docs/shift-left-leadership.md](docs/shift-left-leadership.md) for the programme overview. |
| **AI/ML platform** | KAgent (Kubernetes-native AI agents via Anthropic Claude API) + MLflow experiment tracking + **IDP MCP Server** (catalog/metrics/scaffolding) + **QA MCP Server** (test generation/analysis) + **Contract MCP Server** (9 contract tools) + AI Assistant chat page embedded in Backstage |
| **Observability** | Prometheus + Grafana (local) / CloudWatch + Grafana (AWS); DORA metrics exporter; QA KPI dashboard |
| **Infrastructure** | **Terraform** for foundation (EKS, VPC, ECR, IAM/OIDC, RDS, S3, Secrets Manager) + **Crossplane** for per-service resources (S3, RDS, MSK topics, DynamoDB, SQS) via in-cluster Claims reconciled by ArgoCD. See [docs/crossplane-vs-terraform.md](docs/crossplane-vs-terraform.md) for the boundary. |
| **CI/CD** | GitHub Actions — test → Docker build → ECR push → Helm deploy to EKS |

## Quick Start

```bash
# 1. Click "Use this template" on GitHub, then clone your new repo
git clone https://github.com/YOUR_PACTFLOW_ORG/backstage-platform-template.git && cd backstage-platform-template

# 2. Personalise placeholders AND bootstrap the platform (guided, interactive)
./scripts/setup.sh
# → choose "local" when prompted for environment
# → fill in GITHUB_TOKEN and OAuth credentials when prompted

# 3. When prompted "Start Backstage now?", answer Y
# setup.sh calls: ./scripts/bootstrap-local.sh --start-backstage
# This builds the image, starts Docker Compose, wires nginx, seeds metrics
```

`setup.sh` walks you through placeholder substitution (GitHub org, AWS account, region, cluster name), bootstraps the Kind cluster, and starts Backstage — all in one flow. Steps 2 and 3 can also be run independently for day-2 cluster recreates:

```bash
./scripts/bootstrap-local.sh              # cluster + platform (~15–20 min)
./scripts/bootstrap-local.sh --start-backstage  # Backstage (~2 min)
```

After that, Backstage is at `http://backstage.idp.local` and hello-service at `http://hello-service.idp.local`.

## Platform Summary

| Layer | Local | AWS |
|-------|-------|-----|
| Compute | Kind (Kubernetes in Docker) | Amazon EKS 1.29 |
| Container registry | Local registry (`localhost:5003`) | Amazon ECR |
| Ingress | nginx ingress controller | AWS Load Balancer Controller (ALB) |
| CI | GitHub Actions (`ubuntu-latest`) | GitHub Actions (`ubuntu-latest`) |
| CD | `idp:deploy-local` Backstage action | GitHub Actions (OIDC → ECR → EKS) |
| IaC (foundation) | — | Terraform (EKS, VPC, ECR, IAM, RDS, S3, Secrets Manager) |
| IaC (per-service) | — | Crossplane (S3, RDS, MSK topics, DynamoDB, SQS) — Claims in Git, reconciled by ArgoCD |
| Deployment | Helm (`helm/service-template`) | Helm (`helm/service-template`) |
| Developer portal | Backstage (Docker Compose) | Backstage (EKS) |
| Observability | Prometheus + Grafana | CloudWatch + Grafana |

## Quick Start

### Local (no AWS account needed)

```bash
# Prerequisites: kind, kubectl, helm, docker
./scripts/bootstrap-local.sh

# Access hello-service
curl http://hello-service.idp.local   # after adding /etc/hosts entry
```

### Backstage (developer portal)

```bash
# Set up environment files (first time only)
cp local/.env.example local/.env                        # shared tokens (GitHub, AWS, cluster name)
cp local/backstage/.env.example local/backstage/.env    # Backstage-specific tokens (OAuth, K8s)
# Edit both files and fill in your values
# For AI/ML stack (optional): also set ANTHROPIC_API_KEY=<your-key> in local/.env

# Build image, start Docker Compose, wire nginx, seed metrics (after bootstrap-local.sh)
./scripts/bootstrap-local.sh --start-backstage

# Open http://backstage.idp.local
```

### Local Access URLs

After `bootstrap-local.sh` completes and Backstage is running, everything is reachable via `/etc/hosts` entries (written automatically by the script):

| Service | URL | Default credentials |
|---|---|---|
| **Backstage** | http://backstage.idp.local (or http://localhost:3000) | — (guest mode) |
| **hello-service** | http://hello-service.idp.local | — |
| **Grafana** | http://grafana.idp.local | `admin` / `admin` |
| **ArgoCD** | http://argocd.idp.local | `admin` / *(run `kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath="{.data.password}" \| base64 -d`)* |
| **Prometheus** | http://prometheus.idp.local | — |
| **OpenCost** | http://opencost.idp.local | — |
| **Pushgateway** | http://pushgateway.idp.local | — |
| **KAgent UI** | http://kagent.idp.local | — (requires `bootstrap-ai.sh`) |
| **AI Assistant** | http://backstage.idp.local/ai-assistant | — (requires `bootstrap-ai.sh`) |
| **AI Search** | http://backstage.idp.local/ai-search | — (requires `VOYAGE_API_KEY` in `local/backstage/.env`) |
| **IDP Assistant (A2A)** | http://idp-assistant.idp.local | — (requires `bootstrap-ai.sh`) |
| **MLflow UI** | http://mlflow.idp.local | — (requires `bootstrap-ai.sh`) |
| **IDP MCP Server** | http://idp-mcp-server.idp.local/healthz | — (requires `bootstrap-ai.sh`) |
| **QA MCP Server** | http://qa-mcp-server.idp.local/healthz | — (requires `bootstrap-ai.sh`) |
| **Contract MCP Server** | http://contract-mcp-server.idp.local/healthz | — (requires `bootstrap-ai.sh`) |
| **Local registry** | localhost:5003 | — (no auth) |

> `/etc/hosts` entries are added to `127.0.0.1` by `bootstrap-local.sh`. You may need `sudo` on first run.

### AWS

```bash
# Prerequisites: AWS account with permissions, AWS CLI configured, Terraform, kubectl
cp terraform/terraform.tfvars.example terraform/terraform.tfvars
# Edit terraform/terraform.tfvars — set github_org, aws_region, cluster_name

# Run setup wizard (personalises placeholders, creates .env, then bootstraps AWS)
./scripts/setup.sh
# OR run bootstrap directly:
./scripts/bootstrap.sh  # ~45–60 min

# Validate all components are healthy
./scripts/validate-deployment.sh

# When done, tear down safely
./scripts/cleanup.sh --cluster-name idp-mvp
```

**Full AWS guide:** See [docs/DEPLOYMENT_GUIDE.md](docs/DEPLOYMENT_GUIDE.md) (comprehensive step-by-step, pre-flight checklist, 4 known issues with solutions, troubleshooting, production hardening).

## Project Structure

```
idp-mvp/
├── terraform/              # AWS foundation — EKS, VPC, ECR, IAM, + Crossplane IRSA role
├── local/                  # Local — Kind config, Prometheus values, Backstage compose
├── kubernetes/             # Namespace, RBAC, Backstage manifests, ArgoCD app-of-apps
│   └── crossplane/         # Crossplane providers + XRDs/Compositions (AWS-only)
├── helm/service-template/  # Golden-path Helm chart (both envs)
├── backstage/              # Developer portal: config, templates, custom actions
│   ├── app/                # Backstage monorepo (v1.49.1)
│   │   └── packages/backend/src/modules/idpLocalDeploy.ts
│   ├── catalog/templates/  # nodejs-service, python-service, deploy-to-kind
│   ├── app-config.yaml
│   ├── app-config.local.yaml
│   └── Dockerfile          # Production image (requires yarn build:backend first)
├── services/hello-service/ # Reference service (Go)
├── observability/          # CloudWatch agent + Grafana
├── docs/                   # Architecture, golden path, getting started, local setup
└── scripts/                # All automation scripts — see Scripts Reference below
```

## Scripts Reference

All scripts live in `scripts/`. They can be run standalone (day-2) or are called automatically by `setup.sh` / `bootstrap-local.sh`.

### Day-0 / Day-1 — Platform setup

| Script | Purpose | Called by |
|---|---|---|
| `setup.sh` | **Entry point.** Interactive: replaces placeholders (org, AWS account, region, cluster name), creates `.env` files, then dispatches to local or AWS bootstrap. | You (once) |
| `bootstrap-local.sh` | Creates the Kind cluster, installs nginx ingress, Prometheus/Grafana, ArgoCD, and deploys `hello-service`. `--start-backstage` builds + starts Backstage, wires nginx, seeds metrics. `--destroy` tears everything down: removes scaffolded services from ArgoCD + Helm + git, then deletes the cluster. | `setup.sh` → local path, or standalone |
| `bootstrap.sh` | Provisions AWS EKS, ECR, IAM (Terraform), deploys all platform components, and pushes `hello-service` to ECR. ~45–60 min. See [DEPLOYMENT_GUIDE.md](docs/DEPLOYMENT_GUIDE.md) for full walkthrough. | `setup.sh` → AWS path, or standalone |
| `validate-deployment.sh` | **Post-deploy validation.** Runs 50+ automated tests across AWS infrastructure, Kubernetes, Backstage, observability, GitOps, AI/ML, security, networking, storage. Exit 0 = success, 1 = failure with debug suggestions. | After `bootstrap.sh` completes |
| `cleanup.sh` | **Safe teardown.** Runs eight ordered phases: delete ALBs → disable RDS protection → clean Crossplane resources → empty S3/ECR → **remove scaffolded services from ArgoCD + Helm + git** → terraform destroy → delete CloudWatch log groups → verify. Use `--force` to skip prompts. | When tearing down AWS resources |
| `cleanup-helm-repos.sh` | Removes stale Helm repos and ensures required repos are present before any `helm install`. | `setup.sh` (auto), or standalone |
| `get-k8s-credentials.sh` | Creates a Backstage service account in the cluster and writes K8s credentials to `local/backstage/.env`. | `bootstrap-local.sh` (auto), or standalone |
| `apply-catalog-exporter.sh` | Deploys the Backstage catalog CronJob to the `monitoring` namespace. | `bootstrap-local.sh` (auto), or standalone |
| `bootstrap-ai.sh` | Installs the AI/ML stack (KAgent + MLflow + IDP MCP Server) on top of an existing Kind or AWS cluster. Requires `ANTHROPIC_API_KEY` in `local/.env`. Options: `--skip-mlflow`, `--skip-kagent`, `--skip-mcp`. Optional: set `VOYAGE_API_KEY` in `local/backstage/.env` to enable semantic search at `/ai-search`. Use `--aws` flag for AWS deployment. | After `bootstrap-local.sh` or `bootstrap.sh` |

### Day-2 — Per-service operations

| Tool | Purpose | When to run |
|---|---|---|
| `idp scaffold service` | Scaffold a new service (Node.js / Python / Go) via Backstage API or locally. Built by `setup.sh` automatically. | Each time you add a new service |
| `idp scaffold test-suite` | Scaffold a QA test suite (13 types). Uses Backstage Scaffolder API when running, local generation otherwise. | Each time you add a test suite |
| `setup-runner.sh` | Download, configure, and start a GitHub Actions self-hosted runner so pushes auto-deploy to the local Kind cluster. | After a service repo is created |
| `seed-qa-metrics.sh` | Push synthetic QA metrics so the Grafana QA dashboard shows data immediately. | Optional — demo / dev only |

> `create-service.sh` and `create-test-suite.sh` are deprecated. Use `idp scaffold` instead.

### Execution flow

```
# First-time setup (interactive)
scripts/setup.sh
  └─ Phase 0: replace placeholders in all files
  └─ Phase 1: choose local | aws | skip
       │
       ├─ local path ──► cleanup-helm-repos.sh          (auto)
       │                ► bootstrap-local.sh
       │                    ├─ get-k8s-credentials.sh   (auto)
       │                    └─ apply-catalog-exporter.sh (auto)
       │                ► bootstrap-local.sh --start-backstage
       │                    ├─ docker compose build + up
       │                    ├─ wire nginx endpoint
       │                    ├─ seed QA metrics
       │                    └─ trigger catalog export
       │
       └─ AWS path  ──► bootstrap.sh
                          └─ terraform init/apply
                          └─ helm installs on EKS

# Per new service (day-2)
idp scaffold service --name my-svc --type nodejs   # Backstage API when running
idp scaffold service --name my-svc --type nodejs --local  # offline / pre-Backstage
scripts/setup-runner.sh --repo my-svc

# Per new QA test suite (day-2)
idp scaffold test-suite --name my-e2e  --type playwright    --service my-svc
idp scaffold test-suite --name my-perf --type k6            --service my-svc --vus 20
idp scaffold test-suite --name my-a11y --type accessibility --service my-svc

# Optional
scripts/seed-qa-metrics.sh
```

## `idp` CLI

The `idp` CLI is the day-2 golden path for scaffolding. It is built automatically by `setup.sh` and `bootstrap-local.sh`. To build manually:

```bash
make cli-build     # → ./bin/idp
make cli-install   # → $(go env GOPATH)/bin/idp  (adds to PATH)
```

### Scaffold a service

```bash
idp scaffold service --name payments-api --type nodejs   # nodejs | python | go
idp scaffold service --name payments-api --type python --local  # force local generation
idp scaffold service --help
```

### Scaffold a test suite

```bash
# 16 types: playwright | k6 | pact | newman | zap | datadog | visual |
#           accessibility | cucumber | appium | chaos | mutation | testcontainers |
#           unit | component | iac
idp scaffold test-suite --name hello-e2e   --type playwright    --service hello-service
idp scaffold test-suite --name hello-load  --type k6            --service hello-service --vus 50 --duration 5m
idp scaffold test-suite --name hello-sec   --type zap           --service hello-service --scan-type baseline
idp scaffold test-suite --name hello-a11y  --type accessibility --service hello-service --wcag wcag21aa
idp scaffold test-suite --name hello-chaos --type chaos         --service hello-service --chaos-duration 2m
idp scaffold test-suite --help
```

**Backstage API mode** (default when `http://backstage.idp.local` responds): full golden path — GitHub repo, TechDocs, catalog registration, GitOps PR.

**Local mode** (`--local` flag or Backstage offline): generates files directly in `services/<name>/` or `test-suites/<name>/`.

Token is resolved automatically from `local/backstage/.env` → `backstage/app-config.local.yaml`. Override with `--token` or `BACKSTAGE_TOKEN` env var.

## The Golden Path

```
Backstage → scaffold repo → push code
         → GitHub Actions CI (test + smoke-check)
         → GitHub Actions CD → ECR → EKS (Helm)   [AWS, on push to main]
         → idp:deploy-local (Backstage) → Kind     [local]
         → Prometheus ServiceMonitor → Grafana / CloudWatch
```

### Scaffold a new service

**Via Backstage** (http://backstage.idp.local → Create):

*Service templates:*
- Node.js Service
- Python FastAPI Service
- Go Service
- React Frontend
- Terraform Module
- Team Namespace
- Deploy to Kind
- RDS Database
- Add Secret
*AI/ML templates:*
- AI Agent (KAgent) — scaffold a Kubernetes-native AI agent powered by Anthropic Claude API
- ML Experiment (MLflow) — scaffold a Python ML experiment with tracking, model registry, and CI
- MCP Server (kmcp) — scaffold a Model Context Protocol server managed by the kmcp Kubernetes controller

*QA testing templates (13):*
- Playwright E2E, Visual Regression, Accessibility (axe-core)
- k6 Performance, Chaos Mesh, Testcontainers
- Newman API, Pact Contract
- OWASP ZAP DAST, Datadog Synthetics
- BDD Cucumber, Appium Mobile, Stryker Mutation

**Via `idp` CLI** (built automatically by `setup.sh`):
```bash
# New service — uses Backstage Scaffolder API when reachable, local generation otherwise
idp scaffold service --name my-svc --type nodejs
idp scaffold service --name my-svc --type python
idp scaffold service --name my-svc --type go

# New test suite
idp scaffold test-suite --name my-e2e  --type playwright    --service my-svc
idp scaffold test-suite --name my-perf --type k6            --service my-svc --vus 20 --duration 5m
idp scaffold test-suite --name my-a11y --type accessibility --service my-svc --wcag wcag21aa
idp scaffold test-suite --help   # show all 13 types and flags
```

**Backstage API mode** (when `http://backstage.idp.local` is reachable): creates GitHub repo, registers the service in the catalog, opens a GitOps PR, and generates TechDocs.

**Local mode** (offline / pre-Backstage): generates `services/<name>/` or `test-suites/<name>/` with source code, `catalog-info.yaml`, GitHub Actions CI, Helm values, and a `README.md`.

### Deploy to local Kind

**Via Backstage** (http://backstage.idp.local → Create → "Deploy Service to local Kind cluster"):
1. Pick the service from the catalog
2. Set image tag (default: `latest`)
3. Click Create — the `idp:deploy-local` custom action runs `helm upgrade --install`

**Via CLI:**
```bash
# Push image first
docker build -t localhost:5003/my-svc:latest services/my-svc/
docker push localhost:5003/my-svc:latest

# Deploy
helm upgrade --install my-svc ./helm/service-template \
  --namespace services-dev --create-namespace \
  --set image.repository=localhost:5003/my-svc \
  --set image.tag=latest \
  --values services/my-svc/helm-values-local.yaml
```

> **Troubleshooting — `ImagePullBackOff`:** If a pod shows `ImagePullBackOff` in Backstage or ArgoCD after merging a scaffold PR, the image hasn't been pushed to the local registry yet. Build and push it (steps above), then restart the deployment or click **Sync** in ArgoCD. See [docs/runbooks/image-pull-backoff.md](docs/runbooks/image-pull-backoff.md) for the full procedure.

> **Backstage Kubernetes tab — CPU/memory shows "unknown":** metrics-server is not running. `bootstrap-local.sh` installs it automatically; if you set up the cluster manually run: `kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml && kubectl patch deployment metrics-server -n kube-system --type=json -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'`

## Implementation Phases

| Phase | What | Status |
|-------|------|--------|
| 1 | EKS + VPC + ECR + IAM (Terraform) | Ready |
| 2 | GitHub Actions CI (test + smoke-check) | Ready |
| 3 | Helm service template + conventions | Ready |
| 4 | Backstage + software templates + README generation | Ready |
| 5 | CloudWatch + Grafana observability | Ready |
| 6 | hello-service end-to-end example | Ready |
| 7 | `idp:deploy-local` custom Backstage action | Ready |
| 8 | "Deploy to Kind" standalone Backstage template | Ready |
| 9 | GitHub Actions CD (ECR push → EKS Helm deploy) | Ready |
| 10 | Prometheus ServiceMonitor for app metrics scraping | Ready |
| 11 | EKS access entry for GitHub Actions IAM role | Ready |
| 12 | AI/ML platform — KAgent, MLflow, IDP MCP Server, 3 Backstage AI/ML templates, `bootstrap-ai.sh` | Ready |

## AWS Cost & Scalability

### Free-tier reality check

EKS is **not free-tier compatible** — the control plane costs $0.10/hr (~$73/month) regardless of node count, and the NAT Gateway adds ~$33/month with no free tier. The minimum you'll spend with EKS running continuously is ~$120–150/month.

**To stay near $0:** use `./scripts/bootstrap-local.sh --full` for daily development. Reserve AWS for demos only, then run cleanup. The overnight cost optimizer (enabled by default) shuts nodes down at 8 PM UTC and brings them back at 7 AM, cutting EC2 costs by ~60%.

### Monthly estimate — optimized config (default)

| Service | Config | Est. cost/month |
|---------|--------|-----------------|
| EKS control plane | 1 cluster | ~$73 |
| EC2 worker nodes | 1× t3.medium + overnight scale-to-0 | ~$16 |
| NAT Gateway | 1× single gateway | ~$33 + data |
| RDS PostgreSQL | db.t3.micro, 20 GB — free tier 750 h (yr 1) | ~$0–15 |
| ALB / NLB | Load balancers (free tier: 750 h for 1 ALB) | ~$18–36 |
| EBS | Prometheus 5 Gi gp3 + MLflow 1 Gi | ~$1 |
| CloudWatch | Logs + custom metrics | ~$5–10 |
| Secrets Manager | 5 secrets × $0.40 | ~$2 |
| ECR + S3 | Images + TechDocs | ~$2 |
| **Total (optimized)** | | **~$150–$187/month** |

> **Without optimization** (3 nodes, no scaler, 20 Gi Prometheus, gp2): ~$300–400/month.

### Cost optimizer (enabled by default)

`terraform/terraform.tfvars` ships with:

```hcl
node_group_min_size     = 0        # allows scale-to-zero
node_group_desired_size = 1        # single node during the day
enable_cost_optimizer   = true     # EventBridge Lambdas: nodes→0 at 8 PM UTC, back at 7 AM
budget_monthly_limit_usd = "100"   # SNS alert at $80 actual / $100 forecasted
```

To adjust the schedule (e.g. keep nodes up later):
```hcl
cost_optimizer_scale_down_cron = "cron(0 22 * * ? *)"  # 10 PM UTC
cost_optimizer_scale_up_cron   = "cron(0 6  * * ? *)"  # 6 AM UTC
```

### Skip optional components to save more

The AI/ML stack (KAgent, MLflow, MCP servers) adds ~2–4 extra ALBs and ~6 Gi EBS. Skip it unless you need it:

```bash
./scripts/bootstrap.sh               # core platform only (no AI/ML)
./scripts/bootstrap-ai.sh --aws      # add AI/ML stack later (opt-in)
```

### Production hardening: right-sizing

For production, increase node capacity after confirming cost impact:

```hcl
node_instance_types     = ["t3.large"]
node_group_min_size     = 2
node_group_desired_size = 3
node_group_max_size     = 8
enable_cost_optimizer   = false   # keep nodes up 24/7
environment             = "prod"  # enables RDS deletion protection + 7-day backup
```

See [docs/DEPLOYMENT_GUIDE.md](docs/DEPLOYMENT_GUIDE.md) → Cost Optimization and Production Hardening for the full checklist.

## Known Issues (local development)

| Issue | Status | Workaround |
|-------|--------|------------|
| `/kubernetes` standalone page crashes | By design — disabled in `app-config.local.yaml` | Use the Kubernetes tab on any catalog entity |
| `/catalog-graph` page crashes | Disabled | N/A |
| Cost Overview shows "OpenCost returned 500" | OpenCost pod not running / slow start | `kubectl get pods -n opencost` — wait for it to be Ready |
| Catalog empty on first load | Backstage v1.29+ shows 401 before sign-in completes | Fixed: `dangerouslyDisableDefaultAuthPolicy: true` in local config |

## Documentation

- [Local Setup (Kind)](docs/local-setup.md)
- [Getting Started (AWS)](docs/getting-started.md)
- [Golden Path](docs/golden-path.md)
- [Architecture](docs/architecture.md)
- [AI Assistant](docs/ai-assistant.md)
