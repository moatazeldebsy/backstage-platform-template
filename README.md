# backstage-idp-starter

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-GitHub%20Pages-blue)](https://moatazeldebsy.github.io/backstage-idp-starter/)
[![CI](https://github.com/moatazeldebsy/backstage-idp-starter/actions/workflows/ci.yml/badge.svg)](https://github.com/moatazeldebsy/backstage-idp-starter/actions/workflows/ci.yml)

**A production-ready Internal Developer Platform template** — Backstage developer portal, golden-path Helm chart, 12 software templates + 13 QA testing scaffold templates, AI/ML platform (KAgent + MLflow + MCP Server), Prometheus + Grafana observability, and AWS EKS via Terraform. Runs locally on Kind in minutes.

> **Using this template?** Click **"Use this template"** above, then run `./scripts/setup.sh` to personalise all placeholders for your org.

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
| **QA templates** | 13 testing scaffold templates — Playwright, k6, Pact, Newman, ZAP, Datadog, Visual, a11y, Cucumber, Appium, Chaos Mesh, Stryker, Testcontainers |
| **Golden-path chart** | Single reusable Helm chart for all services — health checks, metrics, RBAC pre-wired |
| **AI/ML platform** | KAgent (Kubernetes-native AI agents via Anthropic Claude API) + MLflow experiment tracking + IDP MCP Server (catalog/metrics/scaffolding tools for agents) + AI Assistant chat page embedded in Backstage |
| **Observability** | Prometheus + Grafana (local) / CloudWatch + Grafana (AWS); DORA metrics exporter; QA KPI dashboard |
| **Infrastructure** | Terraform modules for EKS, VPC, ECR, IAM (OIDC + IRSA), RDS, S3, Secrets Manager |
| **CI/CD** | GitHub Actions — test → Docker build → ECR push → Helm deploy to EKS |

## Quick Start

```bash
# 1. Click "Use this template" on GitHub, then clone your new repo
git clone https://github.com/YOUR_ORG/YOUR_REPO.git && cd YOUR_REPO

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
./scripts/bootstrap-local.sh              # cluster + platform (~10–15 min)
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
| IaC | — | Terraform (EKS, VPC, ECR, IAM, RDS, S3, Secrets Manager) |
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
| **KAgent UI** | http://kagent.idp.local | — (requires `bootstrap-ai.sh`) |
| **MLflow UI** | http://mlflow.idp.local | — (requires `bootstrap-ai.sh`) |
| **IDP MCP Server** | http://idp-mcp-server.idp.local/healthz | — (requires `bootstrap-ai.sh`) |
| **Local registry** | localhost:5003 | — (no auth) |

> `/etc/hosts` entries are added to `127.0.0.1` by `bootstrap-local.sh`. You may need `sudo` on first run.

### AWS

```bash
cp terraform/terraform.tfvars.example terraform/terraform.tfvars
# Edit terraform/terraform.tfvars — set github_org, aws_region, cluster_name
./scripts/bootstrap.sh
```

See [docs/getting-started.md](docs/getting-started.md) for the full walkthrough.

## Project Structure

```
idp-mvp/
├── terraform/              # AWS — EKS, VPC, ECR, IAM
├── local/                  # Local — Kind config, Prometheus values, Backstage compose
├── kubernetes/             # Namespace, RBAC, and Backstage K8s manifests (both envs)
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
| `bootstrap-local.sh` | Creates the Kind cluster, installs nginx ingress, Prometheus/Grafana, ArgoCD, and deploys `hello-service`. `--start-backstage` builds + starts Backstage, wires nginx, seeds metrics. `--destroy` tears everything down. | `setup.sh` → local path, or standalone |
| `bootstrap.sh` | Provisions AWS EKS, ECR, IAM (Terraform), deploys all platform components, and pushes `hello-service` to ECR. | `setup.sh` → AWS path, or standalone |
| `cleanup-helm-repos.sh` | Removes stale Helm repos and ensures required repos are present before any `helm install`. | `setup.sh` (auto), or standalone |
| `get-k8s-credentials.sh` | Creates a Backstage service account in the cluster and writes K8s credentials to `local/backstage/.env`. | `bootstrap-local.sh` (auto), or standalone |
| `apply-catalog-exporter.sh` | Deploys the Backstage catalog CronJob to the `monitoring` namespace. | `bootstrap-local.sh` (auto), or standalone |
| `bootstrap-ai.sh` | Installs the AI/ML stack (KAgent + MLflow + IDP MCP Server) on top of an existing Kind cluster. Requires `ANTHROPIC_API_KEY` in `local/.env`. Options: `--skip-mlflow`, `--skip-kagent`, `--skip-mcp`. | After `bootstrap-local.sh` |

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
# 13 types: playwright | k6 | pact | newman | zap | datadog | visual |
#           accessibility | cucumber | appium | chaos | mutation | testcontainers
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
  --namespace services --create-namespace \
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

## AWS Cost

### Monthly estimate (us-east-1, default config)

| Service | Config | Est. cost/month |
|---------|--------|-----------------|
| EKS control plane | 1 cluster | ~$73 |
| EC2 worker nodes | 2× t3.medium (desired) | ~$61 |
| NAT Gateway | 1× single gateway | ~$33 + data |
| RDS PostgreSQL | db.t3.micro, 20 GB, no Multi-AZ | ~$15 |
| ALB | 1–2 Application Load Balancers | ~$25–40 |
| CloudWatch | Logs + metrics + dashboards | ~$10–20 |
| Secrets Manager | 3 secrets | ~$1 |
| ECR + S3 | Images + TechDocs | ~$2 |
| **Total** | | **~$220–$245/month** |

Scaling to 5 nodes (max_size) adds ~$90/month → up to ~$335/month.

### Cost optimizer (overnight scheduler)

Enable in `terraform/terraform.tfvars` to cut idle hours by ~45 %:

```hcl
enable_cost_optimizer = true
# Optional — defaults shown below (UTC)
cost_optimizer_scale_down_cron = "cron(0 20 * * ? *)"  # 8 pm UTC
cost_optimizer_scale_up_cron   = "cron(0 7  * * ? *)"  # 7 am UTC
```

What it does (via Lambda + EventBridge):
- **8 pm UTC** — EKS nodes scaled to 0, RDS stopped
- **7 am UTC** — EKS nodes restored to `desired_size`, RDS started

Estimated savings vs always-on (11 h off × 30 days):

| Resource | Saving |
|----------|--------|
| EC2 nodes (2× t3.medium) | ~$27/month |
| RDS db.t3.micro | ~$6/month |
| **Total** | **~$33/month** → effective cost ~$190–$210/month |

> **Note:** The EKS control plane ($73) and NAT Gateway ($33) run 24/7 regardless.  
> Budget alert is set at $500/month with SNS → Slack notification.

## Documentation

- [Local Setup (Kind)](docs/local-setup.md)
- [Getting Started (AWS)](docs/getting-started.md)
- [Golden Path](docs/golden-path.md)
- [Architecture](docs/architecture.md)
- [AI Assistant](docs/ai-assistant.md)
