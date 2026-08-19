# Scripts Reference

Full reference for every script under `scripts/`, grouped by when you'd run it. For the `idp` CLI (scaffolding services and test suites), see [CLI Reference](cli-reference.md).

## Prerequisites

Before running anything in `scripts/`, install the tools for the path you're taking:

| Path | Required tools | Verify |
|---|---|---|
| **Local (Kind)** | `git`, `docker`, `kind` ≥ 0.27, `kubectl`, `helm` ≥ 3.14 | `kind version && kubectl version --client && helm version && docker info` |
| **AWS (single or multi-region)** | Everything above, plus `aws` CLI (configured — `aws sts get-caller-identity` must succeed), `terraform` ≥ 1.5, `jq` | `aws sts get-caller-identity && terraform version && jq --version` |
| **Multi-region only** | Everything above, plus `argocd` CLI | `argocd version --client` |
| Optional, auto-installed if missing | `go` ≥ 1.26 (builds the `idp` CLI), Node.js 24 LTS (Backstage) | — |

`setup.sh` and `bootstrap-local.sh`/`bootstrap.sh` each run their own pre-flight check and will tell you exactly what's missing before doing anything destructive — but installing these upfront avoids a mid-run abort. Full local walkthrough: [Local Setup](local-setup.md#prerequisites). Full AWS walkthrough: [AWS Deployment Guide](DEPLOYMENT_GUIDE.md#required-tools).

## `setup.sh` vs `bootstrap-local.sh` — why two scripts?

They solve different problems and are **not interchangeable**:

- **`setup.sh`** — a **one-time** personalization pass + dispatcher. It replaces `moatazeldebsy` / `idp-mvp` / etc. placeholders across the whole repo with your real values, creates `.env` files, builds the `idp` CLI, then asks *local / aws / multi / skip* and hands off to the right bootstrap script.
- **`bootstrap-local.sh`** — the actual **Kind/Rancher platform installer**. It creates the cluster, installs ingress/ArgoCD/observability/OPA, builds and pushes `hello-service`, and wires up Backstage. It's fully standalone and is what you go back to for **day-2** operations (`--destroy`, `--start-backstage`, `--install-argocd`, `--print-urls`, recreating the cluster).

**On a fresh clone you run `setup.sh` and nothing else** — it invokes `bootstrap-local.sh` for you. Running both back to back is the common mistake: it just repeats a 15–20 minute install. If `setup.sh` ended with the "Local IDP platform is up" banner and the access URLs, the cluster is already up.

The ordering exists because bootstrapping before personalizing would point ArgoCD's ApplicationSet, catalog entries, and ingress hostnames at unresolved placeholders instead of your org/cluster name — which is why `setup.sh` owns the dispatch rather than leaving it to you.

Every later invocation (recreate the cluster, add a flag, retry a failed step) goes straight to `bootstrap-local.sh` (or `bootstrap.sh`/`bootstrap-multiregion.sh` on AWS) without touching `setup.sh` again.

## Quick reference

| Script | What it does |
|---|---|
| `setup.sh` | **Start here (once).** Guided interactive setup — replaces placeholders, creates `.env` files, then bootstraps local or AWS |
| `bootstrap-local.sh` | Day-2: re-create Kind cluster + platform. Flags: `--start-backstage`, `--skip-obs`, `--destroy`, `--print-urls` |
| `bootstrap-ai.sh` | Add AI/ML stack on top of a running cluster. **Local only** — on AWS, `bootstrap.sh` already runs this for you. Flags: `--skip-mlflow`, `--skip-mcp`, `--skip-kagent`, `--langfuse`, `--skip-langfuse`, `--langfuse-keys-only`, `--aws`, `--destroy` |
| `bootstrap.sh` | AWS single-region bootstrap: Terraform → EKS → full platform **including AI/ML** (~40–70 min). Pass `--skip-ai` to opt out |
| `bootstrap-multiregion.sh` | AWS multi-region (V2) bootstrap: active-standby eu-central-1 + us-east-1 (~30–50 min). See [Multi-Region](multi-region.md) |
| `verify-secrets.sh` | Pre-flight: checks all required secrets/API keys are set before an AWS deployment. Run before `bootstrap.sh` |
| `validate-deployment.sh` | Post-deploy: 50+ automated checks across infra, K8s, Backstage, observability, GitOps, AI, security |
| `cleanup.sh` | Safe AWS teardown: 9 ordered phases (0–8), removes scaffolded services from ArgoCD + Git before `terraform destroy` |
| `recover-docker-restart.sh` | Patch Kind after Docker Desktop restarts — fixes IPs, restarts ingress, smoke-tests all URLs |
| `register-argocd-cluster.sh` | Multi-region only: registers a spoke EKS cluster's credentials with the hub ArgoCD via Secrets Manager |

## Day-0 / Day-1 — Platform setup

| Script | Purpose | Called by |
|---|---|---|
| `setup.sh` | **Entry point.** Interactive: replaces placeholders (org, AWS account, region, cluster name), creates `.env` files, then dispatches to local or AWS bootstrap. | You (once) |
| `bootstrap-local.sh` | Creates the Kind cluster, installs nginx ingress, Prometheus/Grafana, ArgoCD, and deploys `hello-service`. `--start-backstage` builds + starts Backstage, wires nginx, seeds metrics. `--destroy` tears everything down: removes scaffolded services from ArgoCD + Helm + git, then deletes the cluster. | `setup.sh` → local path, or standalone |
| `verify-secrets.sh` | Checks `GITHUB_TOKEN`, AWS credentials, and other required secrets are set and valid before an AWS deployment. Exits non-zero with the missing item if anything is wrong. | Before `bootstrap.sh` (manual, or see [PRE_DEPLOYMENT_CHECKLIST.md](PRE_DEPLOYMENT_CHECKLIST.md)) |
| `bootstrap.sh` | Provisions AWS EKS, ECR, IAM (Terraform), deploys all platform components — **including the AI/ML stack** (Phase 6 runs `bootstrap-ai.sh --aws` internally, unless `--skip-ai` is passed) — and pushes `hello-service` to ECR. ~40–70 min. See [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) for full walkthrough. | `setup.sh` → AWS path, or standalone |
| `bootstrap-multiregion.sh` | Provisions the V2 active-standby topology: `terraform/global` (KMS, Route53, TGW, Aurora Global, CloudFront) → primary EKS (full stack) → standby EKS (minimal stack) → post-wiring (IRSA, cluster registration, failover RBAC). ~30–50 min. Flags: `--skip-global`, `--skip-standby`, `--skip-obs`, `--skip-ai`. See [Multi-Region](multi-region.md). | `setup.sh` → multi path, or standalone |
| `register-argocd-cluster.sh` | Creates an `argocd-manager` service account on a target EKS cluster and writes its token to Secrets Manager, so the hub ArgoCD can manage it as a spoke. `--cluster <name> --region <region>`. | `bootstrap-multiregion.sh` (auto, for both primary + standby), or standalone to re-register after credential rotation |
| `validate-deployment.sh` | **Post-deploy validation.** Runs 50+ automated tests across AWS infrastructure, Kubernetes, Backstage, observability, GitOps, AI/ML, security, networking, storage. Exit 0 = success, 1 = failure with debug suggestions. | After `bootstrap.sh` completes |
| `cleanup.sh` | **Safe teardown.** Runs nine ordered phases (0–8): stop ArgoCD + Loki writers → delete orphaned ALBs and stale SGs → disable RDS protection → **remove scaffolded services from ArgoCD + Helm + git** → clean Crossplane-tagged resources → empty S3/ECR → terraform destroy → delete CloudWatch log groups → verify. Order matters: ALBs and Crossplane resources are created by in-cluster controllers, so `terraform destroy` alone leaves them orphaned — see [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md#what-terraform-owns-and-what-it-cannot-destroy). Use `--force` to skip prompts. | When tearing down AWS resources |
| `cleanup-helm-repos.sh` | Removes stale Helm repos and ensures required repos are present before any `helm install`. | `setup.sh` (auto), or standalone |
| `get-k8s-credentials.sh` | Creates a Backstage service account in the cluster and writes K8s credentials to `local/backstage/.env`. | `bootstrap-local.sh` (auto), or standalone |
| `apply-catalog-exporter.sh` | Deploys the Backstage catalog CronJob to the `monitoring` namespace. | `bootstrap-local.sh` (auto), or standalone |
| `bootstrap-ai.sh` | Installs the AI/ML stack (KAgent + MLflow + IDP MCP Server) on top of an existing Kind or AWS cluster. Requires `ANTHROPIC_API_KEY` in `local/.env`. Options: `--skip-mlflow`, `--skip-kagent`, `--skip-mcp`, `--force-build`. Langfuse (LLM tracing) is on by default on both local and AWS (`--skip-langfuse` to opt out on either); `--langfuse-keys-only` re-distributes the Langfuse project keys to namespaces labelled `idp.io/langfuse=enabled` without deploying anything. Optional: set `VOYAGE_API_KEY` in `local/backstage/.env` to enable semantic search at `/ai-search`. See [Re-running the bootstrap scripts](#re-running-the-bootstrap-scripts-caching-and-parallelism). | **Local:** manual, run after `bootstrap-local.sh` if you want AI/ML. **AWS:** already run for you by `bootstrap.sh` — only run standalone (`--aws`) to retry a failed AI phase |
| `recover-docker-restart.sh` | **Post-Docker-restart recovery.** Patches Kind cluster after Docker Desktop shuffles container IPs: fixes kubelet.conf, restarts kindnet/kube-proxy, replaces ingress-nginx pods, repairs Grafana PVC permissions, restarts Backstage Docker Compose, and smoke-tests all 11 service URLs. Flags: `--skip-backstage`, `--dry-run`. See [Docker Recovery](docker-recovery.md). | After Docker Desktop restarts unexpectedly |

## Re-running the bootstrap scripts — caching and parallelism

`bootstrap-local.sh`, `bootstrap.sh`, `bootstrap-ai.sh` and
`bootstrap-multiregion.sh` are all designed to be re-run. They skip work they
can prove is unchanged and overlap the work that remains, so a re-run against a
healthy cluster costs a fraction of a cold one.

**What gets skipped on a re-run**

| Work | Skipped when |
|---|---|
| Any Helm release (`helm_upgrade_cached`) | The chart reference, `--version`, every `--set`, and the *contents* of every `--values`/`-f` file are unchanged **and** Helm reports the release `deployed` |
| Docker image builds (hello-service, Backstage, all MCP servers) | The service's source hash is unchanged **and** the tag is still in the registry/ECR |
| KAgent pgvector patch + controller restart | The live Deployment already runs `pgvector/pgvector:pg18`, `DATABASE_VECTOR_ENABLED=true` is set, and every Agent reports `Ready=True` |
| metrics-server install + TLS patch (local) | The pinned version is already the running image / the flag is already present |

Fingerprints live in `.idp-cache/` (gitignored). Every skip is *also* gated on
live cluster or registry state, so deleting `.idp-cache/` only costs time, never
correctness — a wiped registry, a deleted ECR tag, or a release Helm no longer
considers healthy always forces the real work to run again.

Helm fingerprints are keyed by `--kube-context` where one is passed, so
`bootstrap-multiregion.sh` installing the same release on both the hub and
standby clusters caches them independently rather than letting one mask the
other.

**What runs in parallel**

| Script | Overlapped work |
|---|---|
| `bootstrap-local.sh` | All image builds run in the background from just after the registry starts (Step 1) and are joined before Step 13, the first step that needs them. Step 10 (Pushgateway/DORA) joins the Step 11 exporter group. |
| `bootstrap-ai.sh` | MCP server images build in the background, `IDP_BUILD_JOBS` at a time, overlapping the whole KAgent install. MLflow deploys in the background too. |
| `bootstrap.sh` | Argo Workflows and Velero run alongside the AI/ML platform phase. Backstage / ArgoCD / Grafana load balancer hostnames are polled in one loop rather than two sequential ones. |
| `bootstrap-multiregion.sh` | Gatekeeper and Kyverno install concurrently. |

**Environment variables and flags**

| Name | Default | Effect |
|---|---|---|
| `IDP_FORCE` | `0` | Set to `1` to bypass every skip-if-unchanged check and reinstall/rebuild everything. Applies to all four scripts. |
| `--force-build` | off | `bootstrap-ai.sh` only — same idea, scoped to MCP server images and their Helm releases. |
| `IDP_BUILD_JOBS` | `4` | `bootstrap-ai.sh` only — max concurrent image builds. Lower it if Docker Desktop has few CPUs; raising it past your core count usually makes the batch slower. |
| `IDP_TIMING` | `1` | Per-step timings plus a slowest-first summary table on exit. Set to `0` to silence. |
| `HELM_WAIT_SHORT` | `5m` | `helm --wait` budget for the quick installs. Raise it on a cold AWS account where ALB and EBS provisioning is slow. |
| `HELM_WAIT_MED` | `10m` | Same, for the heavier charts (kube-prometheus-stack, Loki, Tempo). |
| `HELM_WAIT_LONG` | `15m` | Used for the ArgoCD retry — the first attempt uses `HELM_WAIT_SHORT`, and only a failure escalates to this. |

The timing summary prints even when a run fails, so it is the fastest way to see
which step is actually costing you time before trying to tune anything.

**AWS image builds and Apple Silicon.** The AWS scripts build `linux/amd64`
images, which run under QEMU emulation on an M-series Mac — the Backstage image
(multi-stage, `yarn install` + `yarn build:backend` in the builder) is the single
most expensive step in a cold AWS bootstrap. Builds go through `docker buildx`
with a `--cache-from/--cache-to type=registry` layer cache stored in ECR beside
the image, so a rebuild only re-emulates the stages that actually changed, and a
build on another machine or in CI hits the same cache. Without buildx available
the scripts fall back to plain `docker build` + `docker push`.

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
