<div align="center">

# 🚀 Backstage Platform Template

### A production-ready Internal Developer Platform — in a single `git clone`

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/moatazeldebsy/backstage-platform-template/actions/workflows/ci.yml/badge.svg)](https://github.com/moatazeldebsy/backstage-platform-template/actions/workflows/ci.yml)
[![Docs](https://img.shields.io/badge/docs-GitHub%20Pages-blue)](https://moatazeldebsy.github.io/backstage-platform-template/)
[![Roadmap](https://img.shields.io/badge/roadmap-GitHub%20Project-8250df)](https://github.com/users/moatazeldebsy/projects/5)

A Backstage developer portal, golden-path Helm chart, 63 scaffold templates (services, QA, mobile, AI/ML, multi-region), an AI/ML platform (KAgent + MLflow + MCP servers), a shift-left quality programme, and full observability — wired to both a local Kind cluster and AWS EKS. Runs locally in ~15 minutes.

> **Using this template?** Click **"Use this template"** above, then run `./scripts/setup.sh` to personalise all placeholders — skipping it leaves ArgoCD's ApplicationSet pointed at the unresolved `moatazeldebsy` placeholder and it won't generate any apps.

![Platform Architecture](docs/assets/platform-architecture.jpg)

<video src="https://github.com/user-attachments/assets/1f62cfc3-f645-4960-b0f7-9725324c9a13"
       poster="docs/assets/idp-platform-teaser-thumbnail.jpg"
       controls muted loop playsinline width="100%">
  <a href="https://github.com/user-attachments/assets/1f62cfc3-f645-4960-b0f7-9725324c9a13"><img src="docs/assets/idp-platform-teaser-thumbnail.jpg" alt="Watch the platform teaser" width="100%"></a>
</video>

**▶ [Watch the 75-second platform teaser](https://github.com/user-attachments/assets/1f62cfc3-f645-4960-b0f7-9725324c9a13)** · **[See the platform in action →](#screenshots)**

</div>

> **Multi-region (V2)** is on `main` and opt-in: active-standby AWS across eu-central-1 (primary) + us-east-1 (standby), via `./scripts/bootstrap-multiregion.sh`. Single-region setups are unaffected. See [docs/multi-region.md](docs/multi-region.md).

> **Agentic Development Platform (ADP)** is on `main` and opt-in: extends the AI/ML stack into a first-class agent layer for both dev workflow (scaffold/code/test/review) and ops (cost/incidents/security), with a human-in-the-loop approval gate for any mutating action. Enable with `./scripts/bootstrap.sh --adp` on AWS, or `./scripts/bootstrap-ai.sh --adp` locally. See [docs/agentic-platform.md](docs/agentic-platform.md).

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
| **Software templates** | 63 templates: 11 blessed golden-path (Node.js, Python, Go, Ruby, JVM, React, LLM App, Team namespace, Create namespace, Add-secret, Decommission) + 52 advanced (infra, QA, mobile, AI/ML, multi-region, observability). Adding one is a single line in `backstage/catalog/all-templates.yaml` (62 there; `deploy-to-kind` is local-only, registered in `app-config.local.yaml`) |
| **QA / test templates** | 18 testing scaffold types — Playwright, k6, Pact, Newman, ZAP, Datadog, Visual Regression, Accessibility, Cucumber, Appium, Chaos Mesh, Stryker Mutation, Testcontainers, DeepEval, Unit, Component, IaC, Flutter Integration. See [CLI Reference](docs/cli-reference.md) |
| **Team isolation** | Per-team namespace (quota + LimitRange + NetworkPolicy + ArgoCD AppProject), per-team SecretStore + Grafana folder, Kyverno-injected `idp:team` tags. See [docs/team-management.md](docs/team-management.md) |
| **Mobile platform** | 7 mobile golden-path templates (Android/iOS/Flutter/SDK/Code Signing/App Store/Device Farm) + 5 mobile scorecard checks. See [docs/mobile-platform.md](docs/mobile-platform.md) |
| **Golden-path chart** | One reusable Helm chart for all services — health checks, metrics, RBAC, PodDisruptionBudget, optional Argo Rollouts canary |
| **Shift-left quality** | Bronze/Silver/Gold scorecard (11 + 5 mobile checks) in Tech Insights + Grafana; PR gates for coverage/vuln/static analysis; ArgoCD PreSync contract gate. See [docs/shift-left-leadership.md](docs/shift-left-leadership.md) |
| **AI/ML platform** | KAgent agents (Claude + GPT-4o) + MLflow + 8 MCP servers (IDP, QA, Contract, GitHub, Cost, ArgoCD, Incident, Security) + Model Serving API + AI scorecard + RAG search over TechDocs. In-portal **KAgent** and **MLflow** pages (agents/MCP servers; experiments, runs and the model registry). See [docs/ai-assistant.md](docs/ai-assistant.md) |
| **LLM observability** | Langfuse — prompt/completion, token counts, cost and latency per agent run, plus versioned agent prompts and a CI drift gate. KAgent exports OTLP directly and all 8 MCP servers trace their tool calls; surfaced as the **AI Observability** page in Backstage. Self-service for your own services via the `enable-langfuse-tracing` and `llm-app-langfuse` templates, with a per-service **Langfuse** entity tab. Installed by default on both targets by `bootstrap-ai.sh` (part of `--with-ai` on AWS); `--skip-langfuse` opts out. See [docs/ai-assistant.md](docs/ai-assistant.md#llm-observability-langfuse) |
| **Observability** | Prometheus + Grafana (local) / CloudWatch + Grafana (AWS); Loki + Tempo; PagerDuty; Sloth SLOs; DORA entity tab per-team; FinOps cost overview. See [docs/dora-finops.md](docs/dora-finops.md) |
| **Datadog** | Cluster-wide Agent (infra metrics, logs, APM intake, AWS only) alongside Prometheus/Grafana; dd-trace on the Backstage backend; Datadog entity tab (dashboard/monitor/SLO status); `enable-datadog-apm` scaffolder template. See [docs/sre-reliability.md](docs/sre-reliability.md#datadog-infra-observability--apm) |
| **Infrastructure** | Terraform for foundation (EKS, VPC, ECR, IAM/OIDC, RDS, S3) + Crossplane for per-service resources (S3, RDS, MSK, DynamoDB, SQS) via ArgoCD-reconciled Claims. See [docs/crossplane-vs-terraform.md](docs/crossplane-vs-terraform.md) |
| **Multi-region V2** | Active-standby eu-central-1 + us-east-1, opt-in. See [docs/multi-region.md](docs/multi-region.md) |
| **Agentic Development Platform (ADP)** | Opt-in agent layer on top of the AI/ML platform — dev-workflow agents (scaffold/code/test/review) and ops agents (cost/incidents/security), gated by a human-in-the-loop approval layer. `bootstrap.sh --adp` (AWS) or `bootstrap-ai.sh --adp` (local). See [docs/agentic-platform.md](docs/agentic-platform.md) |
| **CI/CD** | GitHub Actions — test → Docker build → ECR push → Helm deploy to EKS |

## Quick Start

### Prerequisites

| Path | Install first |
|---|---|
| **Local (Kind)** | `git`, `docker`, `kind` ≥ 0.27, `kubectl`, `helm` ≥ 3.14 — `brew install kind kubectl helm docker` on macOS |
| **AWS** | Everything above, plus `aws` CLI (run `aws configure`), `terraform` ≥ 1.5, `jq` |

**Local machine sizing**: the full stack is ~90 pods using **~3.6 CPU cores and ~9 GB** once settled, or **~4.1 cores and ~11.4 GB** with Langfuse (`bootstrap-ai.sh --langfuse`) as well. Give Docker/Rancher Desktop **8 CPU / 16 GB** for a comfortable run (6 CPU / 12 GB is the working minimum, and it's tight); Langfuse on top wants 10 CPU / 20 GB. Short on resources? Skip the AI/ML layer — it alone is ~2.9 GB — or pass `--skip-obs --skip-policies`. Sizing tiers, the symptoms of an under-resourced cluster, and how to trim: [Machine requirements](docs/local-setup.md#machine-requirements--and-what-to-do-if-you-dont-have-them).

`go` and Node.js are only needed if you want to build the `idp` CLI / run Backstage outside Docker — `setup.sh` builds the CLI for you automatically if Go is present, and skips it with a warning otherwise. Full checklists: [Local Setup](docs/local-setup.md#prerequisites) · [AWS Deployment Guide](docs/DEPLOYMENT_GUIDE.md#required-tools).

```bash
# 1. Click "Use this template" on GitHub, then clone your new repo
git clone https://github.com/moatazeldebsy/backstage-platform-template.git && cd backstage-platform-template

# 2. Run the one script you need — it does everything else for you
./scripts/setup.sh
```

`setup.sh` is the only command you run by hand on a fresh clone. It's a **one-time personalization + dispatcher**: it replaces placeholders across the repo with your GitHub org/cluster name, creates `.env` files, then asks **local or AWS** and triggers the real installer for you automatically — bootstrapping has to happen *after* personalization, otherwise ArgoCD and the catalog would still point at unresolved placeholders.

| # | Runs | Automatic? |
|---|---|---|
| 1 | `setup.sh` — personalises placeholders, asks local or AWS | You run this |
| 2a (local) | `bootstrap-local.sh` — the actual Kind cluster + platform installer (~15–20 min) | Auto, by `setup.sh` |
| 2b (local) | `bootstrap-local.sh --start-backstage` — builds + starts Backstage (~2 min) | Auto, if you answer **Y** to "Start Backstage now?" |
| 2 (AWS) | `bootstrap.sh` — Terraform → EKS → core platform (~40–70 min). AI/ML is **opt-in**: add `--with-ai`, or `--adp` for the agentic layer too | Auto, by `setup.sh` |
| 3 (optional, both targets) | `bootstrap-ai.sh` — adds KAgent + MLflow + Langfuse + MCP servers (`--aws` on EKS) | **Manual** on local and AWS alike |

> **Don't run `setup.sh` and then `bootstrap-local.sh`.** Step 2a above is automatic — `setup.sh` has already run it by the time it finishes. Running it again just repeats a 15–20 minute install. If `setup.sh` printed the "Local IDP platform is up" banner with the access URLs, your cluster is up and the next (optional) step is `bootstrap-ai.sh`.

`bootstrap-local.sh` (and `bootstrap.sh`/`bootstrap-multiregion.sh` on AWS) is also the script you run **standalone** for every day-2 operation afterwards — recreating the cluster, `--destroy`, `--start-backstage`, `--print-urls`, etc. You don't re-run `setup.sh` for those; see [Scripts Reference](docs/scripts-reference.md#setupsh-vs-bootstrap-localsh-why-two-scripts) for the full breakdown of what each script owns.

For AWS, first copy `terraform/terraform.tfvars.example` to `terraform/terraform.tfvars` and set `github_org`, `aws_region`, `cluster_name`, then run `./scripts/verify-secrets.sh` to confirm your credentials/secrets are in place before `bootstrap.sh`.

After local bootstrap, Backstage is at `http://backstage.idp.local` and hello-service at `http://hello-service.idp.local`. Day-2 commands (re-running any step standalone), full walkthroughs, and the AI/ML step: [Scripts Reference](docs/scripts-reference.md) · [Local Setup](docs/local-setup.md) · [AWS Deployment Guide](docs/DEPLOYMENT_GUIDE.md).

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
| **KAgent UI** / **MLflow UI** | http://kagent.idp.local · http://mlflow.idp.local (also surfaced in Backstage at `/kagent` · `/mlflow`) | requires `bootstrap-ai.sh` |
| **AI Observability** / **Langfuse UI** | http://backstage.idp.local/langfuse · http://langfuse.idp.local | requires `bootstrap-ai.sh --langfuse`; Langfuse admin password in the `langfuse-init` Secret |
| **IDP / QA / Contract MCP Servers** | `http://<name>-mcp-server.idp.local/healthz` | requires `bootstrap-ai.sh` |
| **Traces (Tempo)** / **Argo Rollouts** | Traces via Grafana Explore → Tempo datasource (Tempo has no UI; `tempo.idp.local/v1/traces` is a POST-only OTLP endpoint) · http://argo-rollouts.idp.local | auto-deployed by `bootstrap-local.sh` |
| **Local registry** | localhost:5003 | — (no auth) |

### Third-party integrations — bring your own accounts

**You do not need any third-party account to run this platform.** Every
integration below is optional and fails soft: the portal boots, the cluster comes
up, and the relevant tab renders an empty state rather than an error. Nothing is
stubbed or mocked — the config, proxy wiring and secret plumbing are real, so if
you *do* have an account, filling in one variable is all that's needed.

Credentials are supplied by `local/backstage/.env` locally (start from
`local/backstage/.env.example`, which documents each one) and by AWS Secrets
Manager → External Secrets on EKS.

| Integration | What you need | Without it |
|---|---|---|
| **GitHub** (catalog, scaffolder) | PAT in `GITHUB_TOKEN`, scopes `repo`, `read:org`, `workflow`, `delete_repo` | Catalog import and scaffolding to real repos don't work — the rest of the portal is unaffected. In practice this is the one worth setting. |
| **GitHub OAuth** | OAuth App → `AUTH_GITHUB_CLIENT_ID` / `AUTH_GITHUB_CLIENT_SECRET` | Guest mode only — no "Sign in with GitHub" |
| **SonarCloud** / **Snyk** | Free-tier tokens → `SONAR_TOKEN` / `SNYK_TOKEN` | Security tab renders empty; scaffolded CI skips those steps and stays green |
| **Datadog** | `DD_API_KEY` + `DD_APP_KEY` | Datadog tab renders empty. On AWS these also drive the Datadog Agent and APM |
| **PagerDuty** | Read-only REST API key → `PAGERDUTY_TOKEN` | On-call tab renders empty. *Wired for local only today — not yet plumbed through Secrets Manager on AWS ([#407](https://github.com/moatazeldebsy/backstage-platform-template/issues/407))* |
| **Jira** | `JIRA_URL` + `JIRA_TOKEN` = Base64(`email:api_token`) | Issues tab renders empty. *Wired for local only today — not yet plumbed through Secrets Manager on AWS ([#407](https://github.com/moatazeldebsy/backstage-platform-template/issues/407))* |
| **Voyage AI** | `VOYAGE_API_KEY` (free tier: 200M tokens/month) | `/ai-search` returns HTTP 503. Everything else in the AI layer still works |
| **Firebase Test Lab / GCP** | Service-account JSON, base64 → `GCP_SERVICE_ACCOUNT_KEY` | The mobile device-farm and Flutter test-suite templates scaffold fine but their CI can't authenticate |
| **Grafana**, **ArgoCD** | — | Auto-populated by `bootstrap-local.sh`; no account needed |

> The screenshots throughout these docs were taken on an instance with several of
> these configured, so some tabs show live data that will be empty on a fresh
> install until you add your own credentials.

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
| Observability | Prometheus + Grafana | CloudWatch + Grafana + Datadog Agent (infra/APM) |
| LLM observability | Langfuse (default) — in-cluster Postgres + ClickHouse + MinIO | Langfuse (default) — RDS + S3 via Terraform, IRSA-scoped |

### AWS Architecture

![AWS Architecture](docs/assets/aws-architecture.jpg)

Full layer-by-layer breakdown: [docs/architecture.md](docs/architecture.md).

### AWS Architecture — Multi-Region (V2, opt-in)

Active-standby across eu-central-1 (primary) and us-east-1 (warm standby), deployed with
`./scripts/bootstrap-multiregion.sh`. Single-region setups are unaffected.

![AWS V2 — Active-Standby Multi-Region](docs/assets/aws-architecture-v2.jpg)

Topology, DR tiers, and the six rollout phases: [docs/multi-region.md](docs/multi-region.md).

## What it costs on AWS

Measured against a running `idp-mvp` cluster in `us-east-1` on 2026-08-14, at
on-demand list prices, for continuous 24/7 running — that is, before the
overnight scale-down `enable_cost_optimizer` performs by default.
**Local is free** — this is only the EKS path. These are **AWS infrastructure
charges only**; see [what the table excludes](#what-the-table-excludes) below
before treating the total as your bill.

| Component | Qty | ~$/month |
|---|---:|---:|
| EKS control plane | 1 | 73 |
| Worker nodes (`t3.large`) | 6 | 364 |
| NAT gateway | 1 | 33 + data |
| Application Load Balancers — core | 4 | 66 |
| RDS for Backstage (`db.t3.micro`) | 1 | 12 |
| S3 / ECR / Secrets Manager / CloudWatch | — | ~15 |
| **Core platform subtotal** | | **~565** |
| Application Load Balancers — AI/ML | 11 | 181 |
| RDS for Langfuse (`db.t4g.micro`) | 1 | 11 |
| S3 for MLflow + Langfuse artifacts | 2 | ~2 |
| **AI/ML layer subtotal** (`--with-ai`) | | **~195** |
| **Total with AI/ML** | | **~760** |

**The load balancers are the surprise.** Every ALB is ~$16/month before traffic,
and the AI/ML layer creates **eleven** of the fifteen — one per MCP server, plus
KAgent, the IDP assistant, MLflow and Langfuse. That is more than the RDS
instances and S3 combined, and it is why the AI layer is opt-in
(`./scripts/bootstrap.sh --with-ai`) rather than default.

Ways to spend less, roughly in order of effect:

- **Skip the AI/ML layer.** Saves ~$195/month. `enable_ai` and `enable_langfuse`
  gate the infrastructure too, so nothing is provisioned for it.
- **Leave `enable_cost_optimizer = true`** (the default). Scales nodes to zero
  and stops RDS overnight — roughly halves the node and RDS lines if you only
  work office hours. Because it is on by default, a stock deployment on an
  office-hours schedule already lands well under the table above, which measures
  the optimizer-disabled case.
- **Drop the node count.** Six `t3.large` is sized for the full stack including
  AI; the core platform alone fits in fewer. Note the constraint documented on
  `node_instance_types`: nodes are sized by **pod IP capacity**, not CPU/RAM.
- **Tear down when idle.** `./scripts/cleanup.sh` removes everything including
  the orphaned ALBs that a bare `terraform destroy` leaves behind.

### What the table excludes

The total is the platform's own AWS footprint. It is not an all-in run rate:

| Not counted | Why it can matter |
|---|---|
| **Data transfer and NAT data processing** | Charged per GB on top of the NAT hourly rate. Image pulls and cross-AZ traffic dominate it, so it scales with your workload, not with the platform |
| **LLM API spend** | KAgent runs Claude and GPT-4o, and AI Search needs a `VOYAGE_API_KEY`. Those are Anthropic / OpenAI / Voyage bills, not AWS — and on an agent-heavy platform they can exceed the infrastructure. This is precisely what the [Langfuse](docs/ai-assistant.md#llm-observability-langfuse) page exists to show you |
| **Datadog** | Third-party SaaS priced per host and per ingested GB, alongside the Prometheus/Grafana stack that is included |
| **Multi-region V2** | A standby region is close to a second copy of the infrastructure. See [docs/multi-region.md](docs/multi-region.md) |
| **Your own services** | Everything above is the platform. Whatever your teams scaffold onto it is additional |
| **Savings Plans / Reserved Instances** | List prices only. Committed-use discounts take a meaningful cut off the node line |

Verify against the [AWS pricing calculator](https://calculator.aws) for your
region before committing — this table is a measurement of one cluster, not a
quote.

## How It Works — Interaction Flows

![Interaction Flows](docs/assets/interaction-flows.jpg)

| Channel | Who | Entry point |
|---------|-----|-------------|
| **1 — CLI** | Developer | `idp scaffold service` / `idp ai "list templates"` → Scaffolder Engine → GitHub repo |
| **2 — Backstage Portal** | Developer / Platform Engineer | Software Catalog, 63 templates, TechDocs, Tech Radar, AI Assistant, DORA tab, Tech Insights scorecard |
| **3 — AI Agent / MCP** | AI Agent (KAgent + Claude / GPT-4o) | IDP MCP Server, QA MCP Server, Contract MCP Server → Platform APIs |

## Screenshots

All shots are from live clusters — mostly a local Kind cluster brought up with `./scripts/setup.sh` + `./scripts/bootstrap-ai.sh`, plus a few from the AWS EKS path. No mock-ups.

### The portal

The **Platform Dashboard** is the landing page: catalog counts, platform-wide DORA, and every service at a glance.

![Platform Dashboard](docs/assets/screenshots/platform-dashboard.jpg)

| Software Catalog | Teams |
|---|---|
| ![Software Catalog](docs/assets/screenshots/catalog-components.jpg) | ![Teams](docs/assets/screenshots/catalog-teams.jpg) |
| Every service, API, MCP server and test suite, owned and tagged | 8 teams, each with its own namespace, SecretStore and Grafana folder |

Each entity page carries the platform's own tabs — TechDocs, Kubernetes, DORA, Scorecard, Security, Datadog, Trivy, SLOs:

| TechDocs on the entity | Scorecard on the entity |
|---|---|
| ![Entity TechDocs](docs/assets/screenshots/entity-techdocs.jpg) | ![Entity Scorecard](docs/assets/screenshots/entity-scorecard-gold.jpg) |

### Golden path — scaffold → repo → deploy

63 templates in the Scaffolder, filtered by category, tag or owner:

![Scaffolder templates](docs/assets/screenshots/scaffolder-templates.jpg)

| Scaffolder task running | The repo it produced |
|---|---|
| ![Scaffolder task](docs/assets/screenshots/scaffolder-task-run.jpg) | ![Scaffolded repo](docs/assets/screenshots/scaffolded-repo-github.jpg) |
| Generate → push to GitHub → register in catalog → run the first job | CI workflow, Dockerfile, `catalog-info.yaml`, TechDocs — all wired |

Templates are wizards, not a wall of fields — and the last step opens the GitOps PR that puts the new service under ArgoCD:

| Template wizard (LLM App) | The GitOps PR it opened |
|---|---|
| ![LLM App template](docs/assets/screenshots/template-llm-app-langfuse.jpg) | ![GitOps onboarding PR](docs/assets/screenshots/gitops-onboarding-pr.jpg) |
| Model, effort level, trace sampling — chosen up front, wired into the skeleton | An ApplicationSet auto-discovers the service into `services-dev` on merge |

Self-service infrastructure is the same flow — a Crossplane Claim committed to Git instead of a Terraform PR:

![Crossplane templates](docs/assets/screenshots/templates-crossplane.jpg)

| ArgoCD app-of-apps | Argo Rollouts canary |
|---|---|
| ![ArgoCD](docs/assets/screenshots/argocd-applications.jpg) | ![Argo Rollouts](docs/assets/screenshots/argo-rollouts-canary.jpg) |

### Shift-left quality

Bronze / Silver / Gold tiers across every service, with the cheapest unfilled check called out as the next action:

![Scorecard overview](docs/assets/screenshots/scorecard-overview.jpg)

| SLOs and error budgets | QA platform metrics |
|---|---|
| ![SLOs](docs/assets/screenshots/slos.jpg) | ![QA metrics](docs/assets/screenshots/grafana-qa-metrics.jpg) |
| Sloth multi-window burn-rate, live from Prometheus | E2E pass rate, k6 p95 latency and error rate per run |

Those SLOs aren't hand-written YAML — a template generates the Sloth definitions and burn-rate alerts and opens the PR:

![Define Service SLOs template](docs/assets/screenshots/template-define-slos.jpg)

### AI/ML platform and agents

The **AI Assistant** answers in plans, not prose — it maps your intent onto the actual templates on the platform and asks for exactly the inputs they need:

| Ask it anything | It plans the scaffold |
|---|---|
| ![AI Assistant](docs/assets/screenshots/ai-assistant.jpg) | ![AI Assistant scaffold plan](docs/assets/screenshots/ai-assistant-scaffold-plan.jpg) |

…and then it actually runs the scaffolder — repo, deploy target, task ID and the suggested next steps come back in the same chat:

![AI Assistant scaffold result](docs/assets/screenshots/ai-assistant-scaffold-done.jpg)

| KAgent agents | MCP servers and model configs |
|---|---|
| ![KAgent](docs/assets/screenshots/kagent-agents.jpg) | ![MCP servers](docs/assets/screenshots/kagent-mcp-servers.jpg) |

The **MLflow** page gives experiment tracking and the model registry the same in-portal treatment — experiments, recent runs and registered models, read live from the MLflow API, without leaving the catalog:

![MLflow page in Backstage](docs/assets/screenshots/mlflow-page.jpg)

| Agent Approvals (HiTL gate) | MLflow's own UI |
|---|---|
| ![Agent Approvals](docs/assets/screenshots/agent-approvals.jpg) | ![MLflow UI](docs/assets/screenshots/mlflow-experiment.jpg) |
| Every mutating agent action waits for a human — or an auto-approve policy | One click away at `mlflow.idp.local`, for the deep-dive views |

Semantic search over templates, components and TechDocs (Voyage AI + pgvector):

![AI Search](docs/assets/screenshots/ai-search.jpg)

Prometheus tells you *that* an agent ran. **Langfuse** tells you what it cost — prompt and completion, tokens, latency and spend per run, without leaving the portal:

| AI Observability in Backstage | The full Langfuse UI |
|---|---|
| ![AI Observability](docs/assets/screenshots/ai-observability-langfuse.jpg) | ![Langfuse cost dashboard](docs/assets/screenshots/langfuse-cost-dashboard.jpg) |
| Cost and token usage per model, and recent agent runs with latency | Cost by model and environment, per-user spend, and trace drill-down |

### Observability, DORA and FinOps

| DORA metrics | FinOps cost overview |
|---|---|
| ![DORA](docs/assets/screenshots/dora-metrics.jpg) | ![Cost Overview](docs/assets/screenshots/finops-cost-overview.jpg) |
| Four keys platform-wide and per service, with performance bands | OpenCost spend by namespace, team or container |

| Cost Calculator | Grafana — IDP services |
|---|---|
| ![Cost Calculator](docs/assets/screenshots/cost-calculator.jpg) | ![Grafana IDP services](docs/assets/screenshots/grafana-idp-services.jpg) |
| Estimate a service's monthly cost *before* scaffolding it | Request rate, CPU/memory and restarts, filtered by catalog entity |

Incidents are records, not Slack threads — auto-filed from Alertmanager, severity-filtered, and feeding MTTR back into DORA:

![Incidents](docs/assets/screenshots/incidents.jpg)

<details>
<summary><b>More screens</b> — Tech Radar, onboarding, Learning Center, API explorer, Copilot metrics, admin, activity feed, search, support</summary>

<br>

| Tech Radar (63 entries) | API Explorer |
|---|---|
| ![Tech Radar](docs/assets/screenshots/tech-radar.jpg) | ![API Explorer](docs/assets/screenshots/api-explorer.jpg) |

| OpenAPI spec on the entity | Onboarding |
|---|---|
| ![OpenAPI](docs/assets/screenshots/api-openapi.jpg) | ![Onboarding](docs/assets/screenshots/onboarding.jpg) |

| Learning Center | Copilot metrics |
|---|---|
| ![Learning Center](docs/assets/screenshots/learning-center.jpg) | ![Copilot metrics](docs/assets/screenshots/copilot-metrics.jpg) |

| Admin | Activity feed |
|---|---|
| ![Admin](docs/assets/screenshots/admin.jpg) | ![Activity feed](docs/assets/screenshots/activity-feed.jpg) |

| Search | Support |
|---|---|
| ![Search](docs/assets/screenshots/search.jpg) | ![Support](docs/assets/screenshots/support.jpg) |

</details>

## Project Structure

```
backstage-platform-template/
├── scripts/                    # setup.sh · bootstrap-local.sh · bootstrap-ai.sh · cleanup.sh
├── backstage/
│   ├── app/                    # Backstage monorepo (v1.49.1)
│   ├── catalog/templates/      # 63 golden-path templates
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

---

## Roadmap

Status lives on the **[GitHub Project board](https://github.com/users/moatazeldebsy/projects/5)** and in the issues — that is the single source of truth. This section is the honest summary.

### Recently shipped — pre-open-source hardening

The AWS path went effectively untested between May and August 2026. Bringing a real cluster up surfaced a run of defects that are now fixed in the scripts, Terraform and manifests rather than worked around:

- **The Terraform backend was pinned to the maintainer's own S3 bucket**, so any other user's first `terraform init` failed ~30 seconds into a 40-minute script. Both modules now use a partial backend generated by `setup.sh`.
- **Alertmanager's route tree terminated every alert** before it reached the agent event router, so no incident record had ever been created automatically.
- **The scaffolder was dead on AWS** — Datadog APM's `NODE_OPTIONS` replaced rather than appended to the image's, dropping `--no-node-snapshot`.
- **Guest auth was enabled in the production config**, under a comment claiming it was not committed.
- **71 template files hardcoded `*.idp.local`**, so every service scaffolded on AWS got catalog links that only resolve on a laptop.
- CI reported green on paths that ran no jobs at all, including two services with full test suites.

Design decisions from that work are recorded as [ADRs](docs/design/) rather than left implicit: [batch orchestration](docs/design/adr-0001-batch-orchestration.md), [delivery model](docs/design/adr-0002-delivery-model.md), [incident management](docs/design/adr-0003-incident-management.md), [identity and access](docs/design/adr-0004-identity-and-access.md).

### Known limitations

Stated plainly, because finding these by surprise is worse than reading them here:

| Limitation | Detail |
|---|---|
| **Coarse authorization** | Any authenticated user can run any of the 63 templates against any namespace. [ADR-0004](docs/design/adr-0004-identity-and-access.md), issues #153 and #155 |
| **Users and Groups are static YAML** | GitHub Org ingestion is deferred — it cannot work on a personal account |
| **Sloth has no in-cluster operator** | SLO rules are vendored; editing a source file without the `sloth` binary silently changes nothing |
| **The 10 MCP servers bypass GitOps** | They are excluded from the ApplicationSets and deployed by `helm upgrade`. [ADR-0002](docs/design/adr-0002-delivery-model.md) |
| **No CI exercises an AWS bootstrap** | `terraform validate` and a guard against committed account ids is all that gates it |

### Next

Multi-team production hardening, Amazon Bedrock integration, self-hosted small-model serving, and a LangGraph agent template. See the board.

---

## Known Issues (local development)

| Issue | Workaround |
|---|---|
| `/kubernetes` standalone page crashes | By design — disabled in local config. Use the Kubernetes tab on any catalog entity instead |
| `Cost Overview` shows "OpenCost returned 500" | Wait for the OpenCost pod: `kubectl get pods -n opencost` |
| Catalog empty on first load | Fixed: `dangerouslyDisableDefaultAuthPolicy: true` prevents a 401 flash before sign-in |
| `ImagePullBackOff` after scaffold | Image hasn't been pushed to the local registry yet. See [docs/runbooks/image-pull-backoff.md](docs/runbooks/image-pull-backoff.md) |
| Backstage K8s tab shows "unknown" for CPU/memory | metrics-server not running (auto-installed by `bootstrap-local.sh`) |

## Known Issues (AWS)

| Issue | Workaround |
|---|---|
| `terraform init` fails with `AccessDenied` or "Backend configuration required" | `terraform/backend.hcl` has not been generated. Run `./scripts/setup.sh`, or let `bootstrap.sh` create it on first run |
| Nodes fail with `NodeCreationFailure: Instances failed to join the kubernetes cluster` ~20 min in | Usually a VPC/quota issue, or a cold-start apply that reached EKS without the NAT route. `bootstrap.sh` targets `module.vpc` alongside `module.eks` to prevent the latter |
| `Error acquiring the state lock` | An interrupted apply left a stale lock: `cd terraform && terraform force-unlock <lock-id>` |
| Scaffolder tasks fail with "requires `--no-node-snapshot`" | `NODE_OPTIONS` in the deployment replaced the image's value instead of appending. Fixed — it must contain both `--no-node-snapshot` and `--require dd-trace/init` |
| Tearing down leaves resources behind | Use `./scripts/cleanup.sh`, not `terraform destroy` — orphaned ALBs hold the subnets Terraform is trying to delete |

Why each of these was possible, and which file now prevents it:
[docs/aws-install-failure-modes.md](docs/aws-install-failure-modes.md).

---

## Working on this repo with Claude Code

This repo ships its own [Claude Code](https://claude.com/claude-code) configuration under
`.claude/`, so an agent working here starts with the platform's conventions rather than
re-deriving them. Nothing here is required to run the platform — it only affects how Claude
behaves inside this repo.

| Skill (`/name`) | Use it for |
|---|---|
| `platform-architect` | Deciding *where* a change belongs — Terraform vs Crossplane vs Helm vs `kubernetes/`, which of the three interaction channels exposes a capability, which app-config layer |
| `platform-engineer` | Actually building the change across components; knows the per-component CI gate and runs it |
| `platform-reviewer` | Reviewing a diff against this repo's conventions (dual local/AWS coverage, both template front doors, accepted risks) |
| `golden-path-steward` | The 63 scaffolder templates and the `idp` CLI scaffolder that must stay in sync with them |
| `qa-shift-left` | Test strategy, the Bronze/Silver/Gold scorecard, contract testing, flaky-test quarantine |
| `security-advisor` | Kyverno/PSS, IRSA and least-privilege IAM, External Secrets, Dependabot triage |
| `sre-responder` | Live incidents, SLOs and burn-rate alerts, rollback, DR failover, postmortems |

Two sub-agents back them for work that would otherwise flood the main context:
`drift-detector` (compares the known drift pairs — template skeleton vs CLI scaffolder,
`app-config.yaml` vs `all-templates.yaml`, local vs AWS Helm values) and `platform-auditor`
(sweeps a named domain against a checklist). Cross-cutting facts the skills share live in
`.claude/context/platform-map.md`; `CLAUDE.md` carries the always-loaded instructions.

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
| [AI Assistant](docs/ai-assistant.md) | KAgent + MCP server setup and usage, plus Langfuse LLM observability and prompt versioning |
| [Agentic Development Platform (ADP)](docs/agentic-platform.md) | Agent-driven dev workflow + ops, HiTL approval gate, opt-in phases |
| [Agent Approvals](docs/agent-approvals.md) | HiTL gate for agent-initiated mutating actions — policy, approval API, Backstage UI |
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
