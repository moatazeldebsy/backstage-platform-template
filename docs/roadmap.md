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

## Backlog 💡

| Feature | Notes |
|---------|-------|
| GitHub org auto-discovery | Catalog discovers all repos with `catalog-info.yaml` automatically |
| Environment promotion template | Backstage template to promote image dev → staging → prod |
| ECR repository provisioner | `idp:provision-ecr` scaffolder action |
| Namespace provisioner action | `idp:create-namespace` (fast-path alongside PR-based template) |
| Secret rotation template | Backstage template wrapping `idp:provision-secret` |
| ArgoCD GitOps promotion | Push image tag to `helm-values-dev.yaml`, ArgoCD handles rest |
| Multi-region / HA | Second AWS region, Route53 failover |
| Vulnerability scanning in CI | Trivy scan + Cosign signing in GitHub Actions |
| Network policies cluster-wide | Default-deny + explicit allow for all service namespaces |

---

## Milestones

| Milestone | Target | Phases |
|-----------|--------|--------|
| M1: Live CD | Q2 2026 | Phase 1 |
| M2: Ops-ready platform | Q2 2026 | Phase 2 |
| M3: Cost-aware platform | Q3 2026 | Phase 3 |
| M4: Developer excellence | Q3 2026 | Phase 4 |
| M5: Full self-service | Q4 2026 | Backlog |
