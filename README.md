# backstage-idp-starter

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**A production-ready Internal Developer Platform template** — Backstage developer portal, golden-path Helm chart, 19 software templates, Prometheus + Grafana observability, and AWS EKS via Terraform. Runs locally on Kind in minutes.

> **Using this template?** Click **"Use this template"** above, then run `./scripts/setup.sh` to personalise all placeholders for your org.

---

## What You Get

| Capability | Details |
|---|---|
| **Developer portal** | Backstage v1.49.1 with catalog, TechDocs, and custom scaffolder actions |
| **Software templates** | 16 golden-path templates (Node.js, Python, Go, React, Terraform, testing) |
| **Golden-path chart** | Single reusable Helm chart for all services — health checks, metrics, RBAC pre-wired |
| **Observability** | Prometheus + Grafana (local) / CloudWatch + Grafana (AWS); DORA metrics exporter |
| **Infrastructure** | Terraform modules for EKS, VPC, ECR, IAM (OIDC + IRSA), RDS, S3, Secrets Manager |
| **CI/CD** | GitHub Actions — test → Docker build → ECR push → Helm deploy to EKS |

## Quick Start

```bash
# 1. Click "Use this template" on GitHub, then clone your new repo
git clone https://github.com/YOUR_ORG/YOUR_REPO.git && cd YOUR_REPO

# 2. Personalise placeholders AND bootstrap the platform (guided, interactive)
./scripts/setup.sh
```

`setup.sh` walks you through placeholder substitution (GitHub org, AWS account, region, cluster name) and then asks whether to bootstrap **local** (Kind) or **AWS** (EKS), or stop for manual steps. It calls the other scripts automatically in the correct order.

That's it — Backstage is at `http://backstage.idp.local` and hello-service at `http://hello-service.idp.local`.

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
# First time: build the backend bundle
cd backstage/app && yarn install && yarn build:backend && cd ../..

# Set up environment files (both are required before starting)
cp local/.env.example local/.env                        # shared tokens (GitHub, AWS, cluster name)
cp local/backstage/.env.example local/backstage/.env    # Backstage-specific tokens (OAuth, K8s)
# Edit both files and fill in your values

# Start Backstage + Postgres
docker compose -f local/backstage/docker-compose.yml build backstage
docker compose -f local/backstage/docker-compose.yml up -d

# Open http://localhost:3000
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
| **Local registry** | localhost:5003 | — (no auth) |

> `/etc/hosts` entries are added to `127.0.0.1` by `bootstrap-local.sh`. You may need `sudo` on first run.

### AWS

```bash
cp terraform/terraform.tfvars.example terraform/terraform.tfvars
# Edit terraform/terraform.tfvars and terraform/iam.tf (set moatazeldebsy)
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

All scripts live in `scripts/`. They can be run standalone (day-2) or are called automatically by `setup.sh`.

### Day-0 / Day-1 — Platform setup

| Script | Purpose | Called by |
|---|---|---|
| `setup.sh` | **Entry point.** Interactive: replaces placeholders (org, AWS account, region, cluster name), creates `.env` files, then dispatches to local or AWS bootstrap. | You (once) |
| `bootstrap-local.sh` | Creates the Kind cluster, installs nginx ingress, Prometheus/Grafana, ArgoCD, and deploys `hello-service`. Pass `--destroy` to tear down. | `setup.sh` → local path, or standalone |
| `bootstrap.sh` | Provisions AWS EKS, ECR, IAM (Terraform), deploys all platform components, and pushes `hello-service` to ECR. | `setup.sh` → AWS path, or standalone |
| `cleanup-helm-repos.sh` | Removes stale Helm repos and ensures required repos are present before any `helm install`. | `bootstrap-local.sh` (auto) |
| `get-k8s-credentials.sh` | Creates a Backstage service account in the cluster and writes K8s credentials to `local/backstage/.env`. | `setup.sh` after cluster is up, or standalone |
| `apply-catalog-exporter.sh` | Deploys the Backstage catalog CronJob to the `monitoring` namespace. | `setup.sh` after observability is up, or standalone |

### Day-2 — Per-service operations

| Script | Purpose | When to run |
|---|---|---|
| `create-service.sh` | CLI golden path: scaffold a new service repo (Node.js / Python / Go / React / Terraform). Mirrors the Backstage template flow. | Each time you add a new service |
| `setup-runner.sh` | Download, configure, and start a GitHub Actions self-hosted runner for a scaffolded service repo so pushes auto-deploy to the local Kind cluster. | After a service repo is created |
| `seed-qa-metrics.sh` | Push synthetic QA metrics so the Grafana QA dashboard shows data immediately. | Optional — demo / dev only |

### Execution flow

```
# First-time setup (interactive)
scripts/setup.sh
  └─ Phase 0: replace placeholders in all files
  └─ Phase 1: choose local | aws | skip
       │
       ├─ local path ──► bootstrap-local.sh
       │                    └─ cleanup-helm-repos.sh   (auto)
       │                 ► get-k8s-credentials.sh      (auto)
       │                 ► apply-catalog-exporter.sh   (auto)
       │                 ► docker compose up (Backstage)
       │
       └─ AWS path  ──► bootstrap.sh
                          └─ terraform init/apply
                          └─ helm installs on EKS

# Per new service (day-2)
scripts/create-service.sh --name my-svc --type nodejs
scripts/setup-runner.sh   --repo my-svc

# Optional
scripts/seed-qa-metrics.sh
```

## The Golden Path

```
Backstage → scaffold repo → push code
         → GitHub Actions CI (test + smoke-check)
         → GitHub Actions CD → ECR → EKS (Helm)   [AWS, on push to main]
         → idp:deploy-local (Backstage) → Kind     [local]
         → Prometheus ServiceMonitor → Grafana / CloudWatch
```

### Scaffold a new service

**Via Backstage** (http://localhost:3000 → Create):
- Node.js Service
- Python FastAPI Service
- Go Service
- React Frontend
- Terraform Module

**Via CLI:**
```bash
./scripts/create-service.sh --name my-svc --type nodejs
```

Both paths generate: source code, `Dockerfile`, Helm values, `catalog-info.yaml`, GitHub Actions CI, and a service `README.md`.

### Deploy to local Kind

**Via Backstage** (http://localhost:3000 → Create → "Deploy Service to local Kind cluster"):
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
