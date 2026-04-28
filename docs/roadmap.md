# Platform Roadmap

This document tracks the planned feature additions to the Internal Developer Platform. Status is updated as work progresses.

## Status Legend

| Symbol | Meaning |
|--------|---------|
| ✅ | Shipped |
| 🚧 | In Progress |
| 📋 | Planned |
| 💡 | Backlog |

---

## Currently Shipped ✅

| Feature | Details |
|---------|---------|
| Golden path templates | Node.js, Python, Go, React, Terraform, Deploy-to-Kind |
| CI pipeline | Multi-language test detection, ECR push, OIDC auth |
| EKS platform | VPC, EKS v1.29, ECR, RDS, Secrets Manager |
| Observability | Prometheus + Grafana, DORA metrics exporter, hello-service dashboard |
| OPA/Gatekeeper policies | deny-latest-tag, require-health-probes, require-resource-limits, require-labels |
| Backstage portal | 9 templates, custom scaffolder actions, TechDocs, Kubernetes plugin |
| Multi-env namespaces | `services-dev`, `services-staging`, `services-prod` with Pod Security Standards |
| DORA metrics | Deployment frequency, lead time, MTTR, change failure rate via CloudWatch |

---

## Phase 1 — CD to EKS ✅

**Goal:** Every merge to `main` automatically deploys to EKS via Helm.

| Item | Status | Notes |
|------|--------|-------|
| Fix image tag propagation between CI jobs | ✅ | Uses `needs.build-and-push.outputs.image_tag` |
| Slack deploy notifications (success + failure) | ✅ | `slackapi/slack-github-action@v2` |
| GitHub deployment environment tracking | ✅ | `environment: production` set |

**Secrets required:** `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`

---

## Phase 2 — Runbooks + AlertManager ✅

**Goal:** Prometheus alerts route to Slack with clickable runbook links; ops procedures documented in TechDocs.

| Item | Status | Notes |
|------|--------|-------|
| Runbook library (5 runbooks) | ✅ | `docs/runbooks/` — deployment-rollback, pod-crash-loop, high-memory, high-cpu, db-recovery |
| AlertManager enabled (local) | ✅ | `local/observability/prometheus-stack-values.yaml` |
| AlertManager config (Slack routing) | ✅ | `observability/alertmanager/alertmanager-config.yaml` |
| Prometheus alert rules (5 rules) | ✅ | `observability/alertmanager/prometheus-rules.yaml` |
| SLO definitions (Sloth) | ✅ | `observability/slo/hello-service-slos.yaml` — Availability 99.5%, p99 < 500ms |
| AlertManager datasource in Grafana | ✅ | Added to `grafana-helm-values.yaml` |

---

## Phase 3 — FinOps & Cost Management ✅

**Goal:** Cost visibility in AWS and in-cluster; budget alerts to Slack before overspend.

| Item | Status | Notes |
|------|--------|-------|
| AWS Cost Anomaly Detection | ✅ | `terraform/finops.tf` |
| AWS Budgets with Slack alerts | ✅ | Monthly cap, 80% warning + 100% forecasted alerts |
| Slack Lambda for SNS → Slack | ✅ | `terraform/lambda/cost-alert-to-slack/handler.py` |
| OPA cost-tag enforcement | ✅ | `kubernetes/policies/require-cost-tags.yaml` (warn mode) |
| Terraform tag policy (Conftest) | ✅ | `terraform/policies/require-tags.rego` |
| OpenCost in-cluster | ✅ | `kubernetes/finops/opencost.yaml` |
| OpenCost Grafana dashboard | ✅ | Added `finops` provider to Grafana helm values |
| Backstage Cost Insights plugin | ✅ | `@backstage-community/plugin-cost-insights` wired via proxy |

**IAM additions:** `ce:GetCostAndUsage`, `budgets:ViewBudget`, `ce:GetAnomalyMonitors` added to Backstage IRSA

---

## Phase 4 — Team Scorecards (Tech Insights) ✅

**Goal:** Per-service quality scorecard in Backstage; Bronze/Silver/Gold maturity model visible to all teams.

| Item | Status | Notes |
|------|--------|-------|
| Tech Insights backend plugin | ✅ | `@backstage/plugin-tech-insights-backend` added to backend |
| Fact collectors (6 checks) | ✅ | `idpTechInsights.ts` — has-owner, has-techdocs, has-health-probes, has-runbook-url, has-api-definition, uses-pinned-image-tag |
| Bronze / Silver / Gold checks | ✅ | Defined in fact retriever schema |
| Frontend scorecard tab | ✅ | `@backstage/plugin-tech-insights` added to frontend |
| Scorecard metrics exporter | ✅ | `observability/tech-insights-exporter/exporter.py` |
| Team scorecard CronJob | ✅ | `observability/tech-insights-exporter/cronjob.yaml` |
| Annotate all service skeletons | ✅ | `backstage.io/runbook-url` added to all 5 template skeletons |

---

## Phase 5 — Complete Template Library 📋

**Goal:** Close the gap between the 7 templates that exist and the 16+ promised in the README. Every developer persona has a golden path.

| Item | Status | Notes |
|------|--------|-------|
| `add-secret` template | 📋 | Wraps `idp:provision-secret`; generates `ExternalSecret` CRD manifest and instructs `kubectl rollout restart` |
| `rds-database` template | 📋 | Terraform + ExternalSecret; skeleton includes `k8s/database/` manifests |
| `ai-agent-service` template | 📋 | `LLM_API_KEY` wiring; Ollama local / OpenAI prod auto-detection; `agent_invocations_total` metric; `dependsOn: resource:llm-gateway` in `catalog-info.yaml` |
| `model-serving-api` template | 📋 | FastAPI skeleton; `prediction_latency_seconds` histogram; `MODEL_URI` env var; `mlflow-experiment` dependency |
| `ml-training-job` template | 📋 | Argo Workflows `workflow.yaml`; MLflow run logging; CronJob variant |
| `mlflow-experiment` template | 📋 | MLflow tracking server namespace + ingress; registers as `Resource` kind in catalog |
| GitHub org auto-discovery | 📋 | Catalog discovers all repos with `catalog-info.yaml` automatically; replaces static `catalog.locations` list |

---

## Phase 6 — Multi-Environment GitOps Promotion 📋

**Goal:** Merge to `main` deploys to dev automatically; promotion to staging and prod is a one-click PR.

| Item | Status | Notes |
|------|--------|-------|
| ArgoCD app-of-apps for staging | 📋 | `local/argocd/app-of-apps-staging.yaml`; watches `helm-values-staging.yaml` |
| ArgoCD app-of-apps for prod | 📋 | `kubernetes/argocd/app-of-apps-prod.yaml`; watches `helm-values-prod.yaml` |
| `update-image-tag` CI step (multi-env) | 📋 | CI writes SHA tag to `helm-values-dev.yaml`; promotion PR updates staging/prod values |
| Environment promotion Backstage template | 📋 | Scaffolder action that opens a PR updating `helm-values-<target>.yaml` and sets `environment:` in GitHub deployment API |
| Namespace isolation per environment | 📋 | `services-staging` and `services-prod` namespaces with OPA policies matching `services-dev` |

---

## Phase 7 — Developer Experience 📋

**Goal:** Reduce the time between "I wrote code" and "I see it running with full observability" to under 10 minutes.

| Item | Status | Notes |
|------|--------|-------|
| Ephemeral PR environments | 📋 | PR label `env: preview` triggers `helm upgrade` into `services-preview-<pr#>`; torn down on PR close via GitHub Actions |
| Trivy results in Backstage | 📋 | Post-CI Trivy JSON → custom catalog entity; security tab shows CVE count and severity per service |
| DORA metrics Backstage widget | 📋 | Backstage homepage card showing deployment frequency and MTTR per team; reads from CloudWatch via proxy |
| External Secrets Operator full loop | 📋 | `idpProvisionSecret` extended to emit `ExternalSecret` CRD alongside Secrets Manager entry; automatic rotation every 30 days |
| Platform CLI (`platformctl`) | 📋 | Go CLI wrapping `create-service.sh`, `setup-runner.sh`, common `kubectl`/`helm` ops; `--help` + shell autocomplete |
| ECR repository provisioner | 📋 | `idp:provision-ecr` scaffolder action; creates ECR repo + lifecycle policy + IRSA permission |
| Namespace provisioner action | 📋 | `idp:create-namespace` for fast-path team onboarding alongside PR-based `team-namespace` template |

---

## Phase 8 — Advanced Platform 💡

**Goal:** Platform is self-healing, cost-attributed, and secure by default at scale.

| Item | Status | Notes |
|------|--------|-------|
| Network policies cluster-wide | 💡 | Default-deny + explicit allow for all service namespaces; Cilium or Calico |
| Multi-region / HA | 💡 | Second AWS region; Route53 weighted failover; cross-region ECR replication |
| Vulnerability scanning in CI | 💡 | Trivy scan + Cosign signing in GitHub Actions; block on CRITICAL CVEs |
| AI/ML platform namespace | 💡 | `ml-platform` namespace; GPU node group in Terraform; `LimitRange` for GPU quota |
| LLM gateway resource | 💡 | Shared Ollama (local) / OpenAI proxy (AWS) registered as `Resource` in catalog; AI agent templates `dependsOn` it |
| Chaos engineering integration | 💡 | Chaos Mesh installed; `chaos-experiment` Backstage template for fault injection testing |
| Platform API (FastAPI) | 💡 | REST API for programmatic service creation; mirrors Backstage scaffolder for CI/scripting use |

---

## Backlog 💡

| Feature | Notes |
|---------|-------|
| Secret rotation template | Backstage template wrapping `idp:provision-secret` with rotation schedule UI |
| Multi-region / HA | Second AWS region, Route53 failover |
| Backstage plugin: security posture | Aggregate Trivy + OPA policy pass/fail per service into a single security score |

---

## Milestones

| Milestone | Target | Phases |
|-----------|--------|--------|
| M1: Live CD | Q2 2026 | Phase 1 |
| M2: Ops-ready platform | Q2 2026 | Phase 2 |
| M3: Cost-aware platform | Q3 2026 | Phase 3 |
| M4: Developer excellence | Q3 2026 | Phase 4 |
| M5: Complete template library | Q3 2026 | Phase 5 |
| M6: Multi-env GitOps | Q4 2026 | Phase 6 |
| M7: Developer experience | Q4 2026 | Phase 7 |
| M8: Advanced platform | Q1 2027 | Phase 8 |
