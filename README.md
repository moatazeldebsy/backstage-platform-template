<div align="center">

# 🚀 Backstage Platform Template

### A production-ready Internal Developer Platform — in a single `git clone`

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/moatazeldebsy/backstage-platform-template/actions/workflows/ci.yml/badge.svg)](https://github.com/moatazeldebsy/backstage-platform-template/actions/workflows/ci.yml)
[![Docs](https://img.shields.io/badge/docs-GitHub%20Pages-blue)](https://moatazeldebsy.github.io/backstage-platform-template/)
[![Roadmap](https://img.shields.io/badge/roadmap-GitHub%20Project-8250df)](https://github.com/users/moatazeldebsy/projects/5)
[![GitHub stars](https://img.shields.io/github/stars/moatazeldebsy/backstage-platform-template?style=flat)](https://github.com/moatazeldebsy/backstage-platform-template/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/moatazeldebsy/backstage-platform-template?style=flat)](https://github.com/moatazeldebsy/backstage-platform-template/network/members)

A Backstage developer portal, golden-path Helm chart, 51 scaffold templates (services, QA, mobile, AI/ML, multi-region), an AI/ML platform (KAgent + MLflow + MCP servers), a shift-left quality programme, and full observability — wired to both a local Kind cluster and AWS EKS. Runs locally in ~15 minutes.

> **Using this template?** Click **"Use this template"** above, then run `./scripts/setup.sh` to personalise all placeholders for your org. If you skip this step, ArgoCD will generate no apps because its ApplicationSet still has the unresolved `moatazeldebsy` placeholder.

![Platform Architecture](docs/assets/platform-architecture.jpg)

</div>

> **Multi-region (V2)** is on `main` and opt-in: active-standby AWS across eu-central-1 (primary) + us-east-1 (standby), via `./scripts/bootstrap-multiregion.sh`. Single-region setups are unaffected. See [docs/multi-region.md](docs/multi-region.md).

## Compatibility

| Component | Tested version |
|---|---|
| Backstage | v1.49.1 |
| Kubernetes | 1.29 (EKS) · 1.33.1 (Kind) |
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
| **Developer portal** | Backstage v1.49.1 — catalog, TechDocs, Tech Radar (63 entries), custom scaffolder actions |
| **Software templates** | 51 templates: 7 blessed golden-path (Node.js, Python, Go, React, Team namespace, Add-secret, Decommission) + 44 advanced (infra, QA, mobile, AI/ML, multi-region). Adding one is a single line in `backstage/catalog/all-templates.yaml` |
| **QA / test templates** | 18 testing scaffold types — Playwright, k6, Pact, Newman, ZAP, Datadog, Visual Regression, Accessibility, Cucumber, Appium, Chaos Mesh, Stryker Mutation, Testcontainers, DeepEval, Unit, Component, IaC, Flutter Integration. See [CLI Reference](docs/cli-reference.md) |
| **Team isolation** | Per-team namespace (quota + LimitRange + NetworkPolicy + ArgoCD AppProject), per-team SecretStore + Grafana folder, Kyverno-injected `idp:team` tags. See [docs/team-management.md](docs/team-management.md) |
| **Mobile platform** | 7 mobile golden-path templates (Android/iOS/Flutter/SDK/Code Signing/App Store/Device Farm) + 5 mobile scorecard checks. See [docs/mobile-platform.md](docs/mobile-platform.md) |
| **Golden-path chart** | One reusable Helm chart for all services — health checks, metrics, RBAC, PodDisruptionBudget, optional Argo Rollouts canary |
| **Shift-left quality** | Bronze/Silver/Gold scorecard (11 + 5 mobile checks) in Tech Insights + Grafana; PR gates for coverage/vuln/static analysis; ArgoCD PreSync contract gate. See [docs/shift-left-leadership.md](docs/shift-left-leadership.md) |
| **AI/ML platform** | KAgent agents (Claude + GPT-4o) + MLflow + IDP/QA/Contract MCP servers + Model Serving API + AI scorecard + RAG search over TechDocs. See [docs/ai-assistant.md](docs/ai-assistant.md) |
| **Observability** | Prometheus + Grafana (local) / CloudWatch + Grafana (AWS); Loki + Tempo; PagerDuty; Sloth SLOs; DORA entity tab per-team; FinOps cost overview. See [docs/dora-finops.md](docs/dora-finops.md) |
| **Infrastructure** | Terraform for foundation (EKS, VPC, ECR, IAM/OIDC, RDS, S3) + Crossplane for per-service resources (S3, RDS, MSK, DynamoDB, SQS) via ArgoCD-reconciled Claims. See [docs/crossplane-vs-terraform.md](docs/crossplane-vs-terraform.md) |
| **Multi-region V2** | Active-standby eu-central-1 + us-east-1, opt-in. See [docs/multi-region.md](docs/multi-region.md) |
| **CI/CD** | GitHub Actions — test → Docker build → ECR push → Helm deploy to EKS |

## Quick Start

```bash
# 1. Click "Use this template" on GitHub, then clone your new repo
git clone https://github.com/YOUR_ORG/backstage-platform-template.git && cd backstage-platform-template

# 2. Personalise placeholders AND bootstrap the platform (guided, interactive)
./scripts/setup.sh
# → choose "local" or "aws" when prompted for environment
# → fill in GITHUB_TOKEN and OAuth credentials when prompted
# → when asked "Start Backstage now?", answer Y
```

`setup.sh` walks you through placeholder substitution (GitHub org, AWS account, region, cluster name), bootstraps the cluster, and starts Backstage — all in one flow. For AWS, first copy `terraform/terraform.tfvars.example` to `terraform/terraform.tfvars` and set `github_org`, `aws_region`, `cluster_name`.

Day-2 (cluster already personalised, just re-bootstrapping):

```bash
./scripts/bootstrap-local.sh                     # local: cluster + platform (~15–20 min)
./scripts/bootstrap-local.sh --start-backstage    # local: Backstage only (~2 min)
./scripts/bootstrap.sh                            # AWS: full bootstrap (~45–60 min)
./scripts/validate-deployment.sh                  # AWS: 50+ post-deploy health checks
./scripts/cleanup.sh --cluster-name idp-mvp       # AWS: safe teardown
```

After local bootstrap, Backstage is at `http://backstage.idp.local` and hello-service at `http://hello-service.idp.local`. Full walkthroughs: [Local Setup](docs/local-setup.md) · [AWS Deployment Guide](docs/DEPLOYMENT_GUIDE.md) (pre-flight checklist, known issues, troubleshooting). Full command list: [Scripts Reference](docs/scripts-reference.md).

### Local access URLs

Written automatically to `/etc/hosts` by `bootstrap-local.sh` (you may need `sudo` on first run):

| Service | URL | Default credentials |
|---|---|---|
| **Backstage** | http://backstage.idp.local (or http://localhost:3000) | — (guest mode) |
| **hello-service** | http://hello-service.idp.local | — |
| **Grafana** | http://grafana.idp.local | `admin` / `admin` |
| **ArgoCD** | http://argocd.idp.local | `admin` / *(run `kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath="{.data.password}" \| base64 -d`)* |
| **Prometheus** | http://prometheus.idp.local | — |
| **OpenCost** | http://opencost.idp.local | — |
| **AI Assistant** / **AI Search** | http://backstage.idp.local/ai-assistant · `/ai-search` | requires `bootstrap-ai.sh` (+ `VOYAGE_API_KEY` for search) |
| **KAgent UI** / **MLflow UI** | http://kagent.idp.local · http://mlflow.idp.local | requires `bootstrap-ai.sh` |
| **IDP / QA / Contract MCP Servers** | `http://<name>-mcp-server.idp.local/healthz` | requires `bootstrap-ai.sh` |
| **Tempo** / **Argo Rollouts** | http://tempo.idp.local · http://argo-rollouts.idp.local | auto-deployed by `bootstrap-local.sh` |
| **Local registry** | localhost:5003 | — (no auth) |

## Platform Summary

| Layer | Local | AWS |
|-------|-------|-----|
| Compute | Kind (Kubernetes in Docker) | Amazon EKS 1.29 |
| Container registry | Local registry (`localhost:5003`) | Amazon ECR |
| Ingress | nginx ingress controller | AWS Load Balancer Controller (ALB) |
| CI / CD | GitHub Actions → `idp:deploy-local` Backstage action | GitHub Actions (OIDC → ECR → EKS) |
| IaC (foundation) | — | Terraform (EKS, VPC, ECR, IAM, RDS, S3, Secrets Manager) |
| IaC (per-service) | — | Crossplane (S3, RDS, MSK, DynamoDB, SQS) — Claims in Git, reconciled by ArgoCD |
| Deployment | Helm (`helm/service-template`) | Helm (`helm/service-template`) |
| Developer portal | Backstage (Docker Compose) | Backstage (EKS) |
| Observability | Prometheus + Grafana | CloudWatch + Grafana |

### AWS Architecture

![AWS Architecture](docs/assets/aws-architecture.jpg)

Seven layers: GitHub/ArgoCD → AWS Account boundary → ALB edge → VPC/EKS (Backstage, ArgoCD, Prometheus, Grafana, KAgent, MLflow, MCP servers) → Data & Registry (ECR, RDS, S3, DynamoDB, MSK, SQS) → Platform Services (Secrets Manager, IAM, CloudWatch) → IaC (Terraform foundation + Crossplane per-service). See [docs/architecture.md](docs/architecture.md).

## How It Works — Interaction Flows

Three channels reach the platform control plane (GitHub Actions CI, ArgoCD GitOps, Helm golden-path chart, Crossplane Claims):

![Interaction Flows](docs/assets/interaction-flows.jpg)

| Channel | Who | Entry point |
|---------|-----|-------------|
| **1 — CLI** | Developer | `idp scaffold service` / `idp ai "list templates"` → Scaffolder Engine → GitHub repo |
| **2 — Backstage Portal** | Developer / Platform Engineer | Software Catalog, 51 templates, TechDocs, Tech Radar, AI Assistant, DORA tab, Tech Insights scorecard |
| **3 — AI Agent / MCP** | AI Agent (KAgent + Claude / GPT-4o) | IDP MCP Server, QA MCP Server, Contract MCP Server → Platform APIs |

## Project Structure

```
backstage-platform-template/
├── scripts/                    # setup.sh · bootstrap-local.sh · bootstrap-ai.sh · cleanup.sh
├── backstage/
│   ├── app/                    # Backstage monorepo (v1.49.1)
│   ├── catalog/templates/      # 51 golden-path templates
│   ├── app-config.yaml         # base config
│   ├── app-config.local.yaml   # Kind overrides
│   └── app-config.aws.yaml     # EKS overrides
├── helm/service-template/      # single reusable Helm chart
├── services/hello-service/     # reference Go service
├── kubernetes/                 # namespaces · RBAC · ArgoCD app-of-apps · KAgent CRDs
├── local/                      # Kind config · nginx values · Docker Compose
├── aws/                        # EKS-specific: ArgoCD values · External Secrets · Crossplane
├── terraform/                  # EKS · VPC · ECR · IAM · IRSA
├── cli/                        # `idp` CLI (Go)
└── docs/                       # Architecture · golden path · runbooks
```

---

## `idp` CLI

Built automatically by `setup.sh` (`make cli-build` → `./bin/idp`). Scaffolds services and 18 types of test suites via the Backstage API when reachable, or locally otherwise:

```bash
idp scaffold service --name my-svc --type nodejs           # nodejs | python | go
idp scaffold test-suite --name my-e2e --type playwright --service my-svc
idp doctor                                                  # check local tool versions + cluster health
```

Full command reference, all 18 test-suite types, and DX commands (`idp context inject`, `idp learn`, `idp mcp status`, …): [docs/cli-reference.md](docs/cli-reference.md).

## The Golden Path

```
Backstage → scaffold repo → push code
         → GitHub Actions CI (test + smoke-check)
         → GitHub Actions CD → ECR → EKS (Helm)   [AWS, on push to main]
         → idp:deploy-local (Backstage) → Kind     [local]
         → Prometheus ServiceMonitor → Grafana / CloudWatch
```

Scaffold a service or test suite via **Backstage** (`http://backstage.idp.local` → Create) or the `idp` CLI above. Deploy to Kind via Backstage's `idp:deploy-local` action, or `helm upgrade --install my-svc ./helm/service-template ...`. Full walkthrough — template catalog, deploy steps, troubleshooting: [docs/golden-path.md](docs/golden-path.md).

> **Troubleshooting — `ImagePullBackOff`:** the image hasn't been pushed to the local registry yet. Build + push it, then Sync in ArgoCD. See [docs/runbooks/image-pull-backoff.md](docs/runbooks/image-pull-backoff.md).
>
> **Backstage Kubernetes tab shows "unknown" for CPU/memory:** metrics-server isn't running (auto-installed by `bootstrap-local.sh`; if set up manually, apply the [upstream manifest](https://github.com/kubernetes-sigs/metrics-server) with `--kubelet-insecure-tls`).

---

## Roadmap

Shipped work and what's next are tracked on the **[GitHub Project board](https://github.com/users/moatazeldebsy/projects/5)** — the single source of truth for status. Highlights already shipped: EKS + VPC + ECR + IAM via Terraform, CI/CD to EKS, the Backstage golden-path platform, the AI/ML stack, the SRE reliability programme, and the opt-in V2 multi-region architecture. Open items include multi-team production hardening and Amazon Bedrock integration — see the board for the full list.

---

## Known Issues (local development)

| Issue | Workaround |
|---|---|
| `/kubernetes` standalone page crashes | By design — disabled in local config. Use the Kubernetes tab on any catalog entity instead |
| `Cost Overview` shows "OpenCost returned 500" | Wait for the OpenCost pod: `kubectl get pods -n opencost` |
| Catalog empty on first load | Fixed: `dangerouslyDisableDefaultAuthPolicy: true` prevents a 401 flash before sign-in |
| `ImagePullBackOff` after scaffold | See [docs/runbooks/image-pull-backoff.md](docs/runbooks/image-pull-backoff.md) |
| Backstage K8s tab shows "unknown" for CPU/memory | See metrics-server note above |

---

## Documentation

| Doc | Description |
|---|---|
| [Local Setup (Kind)](docs/local-setup.md) | Full local walkthrough |
| [AWS Deployment Guide](docs/DEPLOYMENT_GUIDE.md) | Step-by-step, pre-flight checklist, known issues |
| [Golden Path](docs/golden-path.md) | End-to-end scaffold → deploy → observe flow |
| [Architecture](docs/architecture.md) | Deep-dive into each layer |
| [CLI Reference](docs/cli-reference.md) | `idp` CLI commands and all 18 test-suite types |
| [Scripts Reference](docs/scripts-reference.md) | Every `scripts/*.sh` script |
| [Multi-Region (V2)](docs/multi-region.md) | Active-standby AWS across eu-central-1 + us-east-1 |
| [Team Management](docs/team-management.md) | Onboard a new team: namespace, SecretStore, ArgoCD, Grafana |
| [AI Assistant](docs/ai-assistant.md) | KAgent + MCP server setup and usage |
| [DORA + FinOps](docs/dora-finops.md) | DORA entity tab, SLOs, cost budgets |
| [Contract Testing](docs/contract-testing.md) | MCP-driven contract gates |
| [Mobile Platform](docs/mobile-platform.md) | Android / iOS / Flutter templates |
| [Crossplane vs Terraform](docs/crossplane-vs-terraform.md) | When to use each |
| [Security Scanning](docs/security-scanning.md) | SAST, DAST, SCA setup |
| [Shift-Left Leadership](docs/shift-left-leadership.md) | Bronze/Silver/Gold programme overview |
| [Docker Recovery](docs/docker-recovery.md) | Recover Kind after Docker Desktop restarts |

Full docs site: [moatazeldebsy.github.io/backstage-platform-template](https://moatazeldebsy.github.io/backstage-platform-template/).

---

## Contributing

Issues and PRs are welcome. Before opening a PR, run:

```bash
helm lint helm/service-template
cd backstage/app && yarn lint && yarn test
cd services/hello-service && go test ./...
cd cli && go build ./... && go vet ./...
```

---

## License

[MIT](LICENSE) — free to use, fork, and build on.

---

<div align="center">

**Built with ❤️ for platform engineering teams who want to ship faster.**

[![Use this template](https://img.shields.io/badge/Use%20this%20template-2ea44f?style=for-the-badge&logo=github)](https://github.com/moatazeldebsy/backstage-platform-template/generate)

</div>
