# Scripts Reference

Full reference for every script under `scripts/`, grouped by when you'd run it. For the `idp` CLI (scaffolding services and test suites), see [CLI Reference](cli-reference.md).

## Quick reference

| Script | What it does |
|---|---|
| `setup.sh` | **Start here.** Guided interactive setup — replaces placeholders, creates `.env` files, then bootstraps local or AWS |
| `bootstrap-local.sh` | Day-2: re-create Kind cluster + platform. Flags: `--start-backstage`, `--skip-obs`, `--destroy`, `--print-urls` |
| `bootstrap-ai.sh` | Add AI/ML stack on top of a running cluster. **Local only** — on AWS, `bootstrap.sh` already runs this for you. Flags: `--skip-mlflow`, `--skip-mcp`, `--skip-kagent`, `--aws`, `--destroy` |
| `bootstrap.sh` | AWS bootstrap: Terraform → EKS → full platform **including AI/ML** (~45–60 min). Pass `--skip-ai` to opt out |
| `validate-deployment.sh` | Post-deploy: 50+ automated checks across infra, K8s, Backstage, observability, GitOps, AI, security |
| `cleanup.sh` | Safe AWS teardown: 8 ordered phases, removes scaffolded services from ArgoCD + Git before `terraform destroy` |
| `recover-docker-restart.sh` | Patch Kind after Docker Desktop restarts — fixes IPs, restarts ingress, smoke-tests all URLs |

## Day-0 / Day-1 — Platform setup

| Script | Purpose | Called by |
|---|---|---|
| `setup.sh` | **Entry point.** Interactive: replaces placeholders (org, AWS account, region, cluster name), creates `.env` files, then dispatches to local or AWS bootstrap. | You (once) |
| `bootstrap-local.sh` | Creates the Kind cluster, installs nginx ingress, Prometheus/Grafana, ArgoCD, and deploys `hello-service`. `--start-backstage` builds + starts Backstage, wires nginx, seeds metrics. `--destroy` tears everything down: removes scaffolded services from ArgoCD + Helm + git, then deletes the cluster. | `setup.sh` → local path, or standalone |
| `bootstrap.sh` | Provisions AWS EKS, ECR, IAM (Terraform), deploys all platform components — **including the AI/ML stack** (Phase 6 runs `bootstrap-ai.sh --aws` internally, unless `--skip-ai` is passed) — and pushes `hello-service` to ECR. ~45–60 min. See [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) for full walkthrough. | `setup.sh` → AWS path, or standalone |
| `validate-deployment.sh` | **Post-deploy validation.** Runs 50+ automated tests across AWS infrastructure, Kubernetes, Backstage, observability, GitOps, AI/ML, security, networking, storage. Exit 0 = success, 1 = failure with debug suggestions. | After `bootstrap.sh` completes |
| `cleanup.sh` | **Safe teardown.** Runs eight ordered phases: delete ALBs → disable RDS protection → clean Crossplane resources → empty S3/ECR → **remove scaffolded services from ArgoCD + Helm + git** → terraform destroy → delete CloudWatch log groups → verify. Use `--force` to skip prompts. | When tearing down AWS resources |
| `cleanup-helm-repos.sh` | Removes stale Helm repos and ensures required repos are present before any `helm install`. | `setup.sh` (auto), or standalone |
| `get-k8s-credentials.sh` | Creates a Backstage service account in the cluster and writes K8s credentials to `local/backstage/.env`. | `bootstrap-local.sh` (auto), or standalone |
| `apply-catalog-exporter.sh` | Deploys the Backstage catalog CronJob to the `monitoring` namespace. | `bootstrap-local.sh` (auto), or standalone |
| `bootstrap-ai.sh` | Installs the AI/ML stack (KAgent + MLflow + IDP MCP Server) on top of an existing Kind or AWS cluster. Requires `ANTHROPIC_API_KEY` in `local/.env`. Options: `--skip-mlflow`, `--skip-kagent`, `--skip-mcp`. Optional: set `VOYAGE_API_KEY` in `local/backstage/.env` to enable semantic search at `/ai-search`. | **Local:** manual, run after `bootstrap-local.sh` if you want AI/ML. **AWS:** already run for you by `bootstrap.sh` — only run standalone (`--aws`) to retry a failed AI phase |
| `recover-docker-restart.sh` | **Post-Docker-restart recovery.** Patches Kind cluster after Docker Desktop shuffles container IPs: fixes kubelet.conf, restarts kindnet/kube-proxy, replaces ingress-nginx pods, repairs Grafana PVC permissions, restarts Backstage Docker Compose, and smoke-tests all 9 service URLs. Flags: `--skip-backstage`, `--dry-run`. See [Docker Recovery](docker-recovery.md). | After Docker Desktop restarts unexpectedly |

## Day-2 — Per-service operations

| Tool | Purpose | When to run |
|---|---|---|
| `idp scaffold service` | Scaffold a new service (Node.js / Python / Go) via Backstage API or locally. Built by `setup.sh` automatically. | Each time you add a new service |
| `idp scaffold test-suite` | Scaffold a QA test suite (18 types). Uses Backstage Scaffolder API when running, local generation otherwise. | Each time you add a test suite |
| `setup-runner.sh` | Download, configure, and start a GitHub Actions self-hosted runner so pushes auto-deploy to the local Kind cluster. | After a service repo is created |
| `seed-qa-metrics.sh` | Push synthetic QA metrics so the Grafana QA dashboard shows data immediately. | Optional — demo / dev only |

## Execution flow

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
