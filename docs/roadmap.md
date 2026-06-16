# Platform Roadmap

This document tracks the planned feature additions to the Internal Developer Platform.
Status is updated as work progresses.

> **GitHub Project Roadmap:** All roadmap items are tracked as issues in the
> [GitHub Project board](../../projects) with milestone dates, priority labels, and
> a timeline view. The sections below are the canonical source of truth; the GitHub
> Project syncs from them.

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
| SRE reliability programme | PodDisruptionBudgets, Sloth SLOs, burn-rate alerts, Loki+Tempo+PagerDuty observability, Argo Rollouts canary, multi-env GitOps promotion, blameless postmortem template, per-team cost budgets, KAgent guardrails + audit log |
| Golden path templates | Node.js, Python, Go, React, Terraform, Deploy-to-Kind (7 templates) |
| CI pipeline | Multi-language test detection, ECR push, OIDC auth, graceful skip when secrets absent |
| EKS platform | VPC, EKS v1.29, ECR, RDS, Secrets Manager via Terraform |
| Observability | Prometheus + Grafana, DORA metrics exporter, hello-service + QA dashboards |
| OPA/Gatekeeper policies | deny-latest-tag, require-health-probes, require-resource-limits, require-labels, require-cost-tags |
| Backstage portal | 7 templates, custom scaffolder actions (`idpLocalDeploy`, `idpProvisionSecret`, `idpSetRepoSecrets`), TechDocs, Kubernetes plugin |
| Multi-env namespaces | `services-dev`, `services-staging`, `services-prod` with Pod Security Standards |
| DORA metrics | Deployment frequency, lead time, MTTR, change failure rate — CloudWatch (AWS) + Pushgateway (local) |
| Community health | CONTRIBUTING.md, CODE_OF_CONDUCT.md, issue templates, PR template, CODEOWNERS |
| GitOps | ArgoCD app-of-apps for local and AWS; image tag commit loop via `build-and-deploy.yml` |
| Test suite template library | 18 templates covering the full pyramid: unit, component, integration, contract, E2E, performance, security (DAST), visual, accessibility, mobile (Appium), chaos, LLM eval, mutation, synthetic, IaC, Flutter integration |
| Contract testing stack | `contract-mcp-server` (9 tools), `contract-assistant` KAgent agent, `enable-contract-testing` scaffold template |
| QA MCP server | `qa-mcp-server` deployed alongside `idp-mcp-server`; QA-specific tools exposed as MCP |
| Three-way repo split | `local/` (Kind-only), `aws/` (EKS-only), `kubernetes/` (shared) — enforced by bootstrap scripts; no cross-reads |
| Mobile golden-path platform | 7 templates: android-app, ios-app, flutter-app (primary); mobile-code-signing, mobile-app-store-deploy, mobile-device-farm, mobile-sdk (add-on); plus flutter-integration-test-suite; 5 mobile Tech Insights checks |
| DORA entity tab + enhanced FinOps | Per-component DORA tab (Elite/High/Medium/Low badges, 7-day sparklines, Prometheus-backed); FinOps cost overview with date-range selector, namespace/team/container breakdown, efficiency badges |
| Production security hardening | Guest auth removed from AWS config; session secret from Secrets Manager; TLS cert validation enabled for RDS; AWS Account ID no longer hardcoded |
| Template annotation standardisation | 20 templates updated with PagerDuty, Jira, and `idp.io/quality-gates` annotations; optional Integrations step added to all test-suite templates |
| `recover-docker-restart.sh` | Automated Kind cluster recovery after Docker Desktop restarts: patches kubelet.conf, restarts networking, replaces ingress-nginx, repairs Grafana PVC, smoke-tests 9 URLs |

---

## Phase 0 — Open-Source Readiness ✅

**Goal:** Fix first-run correctness and credibility issues before promoting the project publicly.

| Item | Status | Notes |
|------|--------|-------|
| Fix `Moataz Nabil` in `catalog-info.yaml` | ✅ | Resolved in personalisation pass during `setup.sh` |
| Correct README template count | ✅ | README updated to reflect 28 templates |
| Add `SECURITY.md` | ✅ | `SECURITY.md` added — vulnerability disclosure policy |
| Add Dependabot config | ✅ | `.github/dependabot.yml` present |
| Verify all Phase 1–4 shipped items exist on disk | ✅ | `observability/slo/`, `terraform/finops.tf`, `idpTechInsights.ts`, `kubernetes/finops/` all confirmed |
| Semantic versioning + `CHANGELOG.md` | ✅ | `CHANGELOG.md` follows Keep-a-Changelog; v0.1.0 tagged |

---

## Phase 1 — CD to EKS ✅

**Goal:** Every merge to `main` automatically deploys to EKS via Helm.

| Item | Status | Notes |
|------|--------|-------|
| Fix image tag propagation between CI jobs | ✅ | Uses `needs.build-and-push.outputs.image_tag` |
| Slack deploy notifications (success + failure) | ✅ | `slackapi/slack-github-action@v2` |
| GitHub deployment environment tracking | ✅ | `environment: production` set |
| Graceful skip when `AWS_ROLE_ARN` is unset | ✅ | Guard step in `build-and-push` and `update-image-tag` jobs |

**Secrets required:** `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`

---

## Phase 2 — Runbooks + AlertManager ✅

**Goal:** Prometheus alerts route to Slack with clickable runbook links; ops procedures documented in TechDocs.

| Item | Status | Notes |
|------|--------|-------|
| Runbook library (8 runbooks) | ✅ | `docs/runbooks/` — deployment-rollback, pod-crash-loop, high-memory, high-cpu, db-recovery, image-pull-backoff |
| AlertManager enabled (local) | ✅ | `local/observability/prometheus-stack-values.yaml` |
| AlertManager config (Slack routing) | ✅ | `observability/alertmanager/alertmanager-config.yaml` |
| Prometheus alert rules | ✅ | `observability/alertmanager/prometheus-rules.yaml` |
| AlertManager datasource in Grafana | ✅ | Added to `grafana-helm-values.yaml` |

---

## Phase 3 — FinOps & Cost Management ✅

**Goal:** Cost visibility in AWS and in-cluster; budget alerts to Slack before overspend.

| Item | Status | Notes |
|------|--------|-------|
| OPA cost-tag enforcement | ✅ | `kubernetes/policies/require-cost-tags.yaml` (warn mode) |
| Per-team cost budgets | ✅ | Monthly budget annotations on Group entities; OpenCost-backed actuals; TeamBudgetWarning/TeamBudgetExceeded PrometheusRules; `idp_team_budget_utilization_ratio` metric in Pushgateway |
| OpenCost in-cluster | ✅ | `kubernetes/finops/opencost.yaml` |
| OpenCost Grafana dashboard | ✅ | `finops` provider in Grafana helm values |
| AWS Cost Anomaly Detection | ✅ | `terraform/finops.tf` |
| AWS Budgets with Slack alerts | ✅ | Monthly cap, 80% warning + 100% forecasted alerts |
| Backstage Cost Insights plugin | ✅ | `@backstage-community/plugin-cost-insights` wired via proxy |

---

## Phase 4 — Team Scorecards (Tech Insights) ✅

**Goal:** Per-service quality scorecard in Backstage; Bronze/Silver/Gold maturity model visible to all teams.

| Item | Status | Notes |
|------|--------|-------|
| Tech Insights backend plugin | ✅ | `@backstage/plugin-tech-insights-backend` |
| Fact collectors (6 checks) | ✅ | has-owner, has-techdocs, has-health-probes, has-runbook-url, has-api-definition, uses-pinned-image-tag |
| Bronze / Silver / Gold checks | ✅ | Defined in fact retriever schema |
| Frontend scorecard tab | ✅ | `@backstage/plugin-tech-insights` |
| Scorecard metrics exporter + CronJob | ✅ | `observability/tech-insights-exporter/` |
| Annotate all service skeletons | ✅ | `backstage.io/runbook-url` in all template skeletons |

---

## Phase 5 — Open-Source Launch Readiness �

**Goal:** Make the project a compelling, trustworthy open-source reference. Every item here
directly affects GitHub discoverability, first-run experience, or contributor confidence.

| Item | Status | Notes |
|------|--------|-------|
| Demo GIF / screenshot in README | 📋 | #1 driver of GitHub stars; shows the golden path end-to-end in 30 seconds |
| GitHub Pages deployment (MkDocs) | ✅ | Published via `docs.yml` GitHub Actions workflow; served at GitHub Pages. Covers architecture, golden path, shift-left (incl. leadership guide), contract testing, Crossplane, AI assistant, runbooks, and roadmap |
| Trivy + Cosign in CI | ✅ | Trivy vulnerability scan + Cosign image signing in CI pipeline |
| Compatibility matrix | 📋 | Backstage v1.49, K8s 1.32, Helm 3.x, Kind 0.27 — to be declared |
| Semantic versioning + `CHANGELOG.md` | ✅ | `CHANGELOG.md` follows Keep-a-Changelog format; v0.1.0 tagged |
| SLO definitions (Sloth) | ✅ | `observability/slo/hello-service-slos.yaml` — 99.5% availability, p99 < 500ms |
| Complete template library (add-secret, rds-database) | ✅ | `add-secret/`, `rds-database/`, `s3-bucket/`, `kafka-topic/`, `eks-cluster/` all added |
| GitHub org auto-discovery | 📋 | Catalog auto-discovers repos with `catalog-info.yaml` |

---

## Phase 6 — Multi-Environment GitOps Promotion 📋

**Goal:** Merge to `main` deploys to dev automatically; promotion to staging and prod is a
one-click PR. This is the most-requested feature after first scaffold.

| Item | Priority | Notes |
|------|----------|-------|
| ArgoCD app-of-apps for staging | 🔴 High | `local/argocd/app-of-apps-staging.yaml`; watches `helm-values-staging.yaml` |
| ArgoCD app-of-apps for prod | 🔴 High | `aws/argocd/app-of-apps-prod.yaml`; watches `helm-values-prod.yaml` |
| `update-image-tag` CI step (multi-env) | 🔴 High | CI writes SHA tag to `helm-values-aws.yaml`; promotion PR updates staging/prod values |
| Namespace isolation per environment | 🟡 Medium | `services-staging` and `services-prod` with OPA policies matching `services-dev` |
| Environment promotion Backstage template | 🟡 Medium | Scaffolder action opens a PR updating `helm-values-<target>.yaml` |

---

## Phase 7 — AI/ML Platform ✅

**Goal:** Every developer persona — including ML engineers and AI teams — has a golden path.

### Phase 7 Core AI/ML Capabilities (✅ Completed)

| Item | Status | Notes |
|------|--------|-------|
| `ai-agent-service` template (`ai-agent-kagent`) | ✅ | Anthropic Claude API via KAgent; full skeleton in `backstage/catalog/templates/ai-agent-kagent/` |
| `mlflow-experiment` template | ✅ | MLflow tracking server; registers as `Resource` kind; `backstage/catalog/templates/mlflow-experiment/` |
| `mcp-server` template | ✅ | Model Context Protocol server skeleton; `backstage/catalog/templates/mcp-server/` |
| KAgent platform deployment | ✅ | KAgent installed on local Kind + AWS EKS; ingress at `kagent.idp.local` / AWS ALB |
| MLflow tracking server | ✅ | MLflow installed on local Kind + AWS EKS; ingress at `mlflow.idp.local` / AWS ALB |
| IDP MCP Server | ✅ | `services/idp-mcp-server/` — exposes 6 IDP operations as MCP tools; `bootstrap-ai.sh` bootstraps the full stack |
| QA MCP Server | ✅ | `services/qa-mcp-server/` — QA-specific tools (test generation, result analysis); managed by ArgoCD in `services-dev` |
| Contract MCP Server | ✅ | `services/contract-mcp-server/` — 9 tools: `fetch_service_contract`, `auto_discover_contracts`, `register_contract`, `validate_compatibility`, `detect_breaking_changes`, and more |
| `contract-assistant` KAgent agent | ✅ | `kubernetes/kagent/contract-agent.yaml` — uses all 9 contract tools + `catalog_search` + `list_deployments` |
| `enable-contract-testing` template | ✅ | Scaffold template that deploys `contract-mcp-server`, applies KAgent CRDs, and auto-registers the target service |
| Scaffold actions: deploy-agent, run-training-job, deploy-mcp-server | ✅ | `idpDeployAgent`, `idpRunTrainingJob`, `idpDeployMcpServer` modules in `backstage/app/packages/backend/src/modules/` |

### Phase 7a — AI-Native Platform Enhancements (✅ Completed Q2 2026)

**Priority 1 — AI Platform Foundations:**

| Item | Status | Notes |
|---|---|---|
| OpenAI ModelConfig CRD | ✅ | `kubernetes/kagent/modelconfig-openai.yaml` with GPT-4o support; OPENAI_API_KEY secret auto-provisioned in `bootstrap-ai.sh` |
| AI Observability Dashboard | ✅ | Grafana dashboard (`observability/grafana/dashboards/ai/ai-platform.json`) with MCP tool call metrics, latency distribution, error rates, cost attribution per server |
| RAG Document Indexing | ✅ | `idpRagSearch.ts` extended with `indexMarkdownFiles()` for semantic search across TechDocs, runbooks, and platform documentation |

**Priority 2 — AI Service Lifecycle:**

| Item | Status | Notes |
|---|---|---|
| `model-serving-api` template | ✅ | Scaffolder template for Ollama (local Kind) and vLLM (AWS EKS) model servers; `idp:deploy-model-server` action with secure TLS verification and input validation |
| AI Platform Scorecard | ✅ | 3 new Tech Insights checks: `has-model-card`, `has-eval-suite`, `has-ai-observability`; updated Bronze/Silver/Gold tiers (14 checks total) with AI Governance group |
| Prompt Lifecycle Management | ✅ | System prompts extracted to ConfigMaps (`kubernetes/kagent/prompts/`) and referenced by Agent CRDs for zero-downtime prompt updates |

**Priority 3 — ML Workflows & Cost Attribution:**

| Item | Status | Notes |
|---|---|---|
| Argo Workflows orchestration | ✅ | `local/argo-workflows/values.yaml` + `aws/argo-workflows/values.yaml` with S3 artifact storage (AWS IRSA); integrated into `bootstrap-local.sh` (--install-argo-workflows flag) and `bootstrap.sh` (Phase 6a) |
| AI Cost Attribution | ✅ | MCP server metrics enhanced with `server` label; `ai_api_calls_total` counter tracks cost per model; Team labels on Agent CRDs; ServiceMonitor enables per-team tracking; per-agent audit log ([AUDIT] JSON) and `dry_run` mode on `scaffold_service` |

### Phase 7 Successor Items

| Item | Status | Notes |
|---|---|---|
| KAgent tool-call audit log + guardrails | ✅ | Structured [AUDIT] JSON logs on every MCP tool call; mcp_agent_tool_calls_total{agent} counter; dry_run on scaffold_service; KAgent system-prompt guardrails; ScaffoldServiceHighRate + McpToolErrorRateHigh alerts |
| Event Bus (`agent-event-router`) | ✅ | Receives GitHub / AlertManager / ArgoCD webhooks → fans out to agents via A2A; HMAC + bearer-token auth |
| `platform-assistant` unified agent | ✅ | Single Backstage entry point routing across IDP + QA + contract tools (22 tools); replaces direct `idp-assistant` calls |
| Model routing (Sonnet / Opus ModelConfigs) | ✅ | `claude-sonnet` (Sonnet 4.6) and `claude-opus` (Opus 4.8) ModelConfig CRDs; specialists upgraded to Sonnet |
| Persistent user memory | ✅ | ConfigMap-backed per-user preferences (`get_user_memory` / `set_user_memory` tools); identity bound at HTTP layer, not LLM args |
| `github-mcp-server` | ✅ | `get_pr_diff`, `add_pr_comment`, `get_ci_status`; used by `qa-assistant` for automated PR review |
| `catalog_semantic_search` tool | ✅ | Natural-language vector search via Voyage AI + pgvector; added to `idp-mcp-server` |
| Quick-action chips in chat UI | ✅ | 6 clickable suggestion chips on empty chat in `AiAssistantPage` |
| `idp ai` CLI command | ✅ | `idp ai "<prompt>"` — sends A2A message to `platform-assistant`, streams response to terminal |
| `ml-training-job` template | 📋 | Argo Workflows scaffold with MLflow experiment logging; CronJob variant for scheduled model training |
| Automated deepeval CI gate | 📋 | GitHub Actions workflow on PR to Agent prompts; blocks merge if AnswerRelevancy < 0.7 or ToolCorrectness < 0.8 |

### Phase 7d — Agentic Platform (Sprint 4+) 📋

| Sprint | Features | Status |
|--------|---------|--------|
| Sprint 4 | `argocd-mcp-server` + `release-agent` + `cost-mcp-server` + `cost-agent` | ✅ |
| Sprint 5 | `incident-mcp-server` + `incident-agent` + `notification-mcp-server` | 📋 |
| Sprint 6 | RAG expansion (runbooks, ADRs) + hallucination detection + Ollama ModelConfig + A2A delegation | 📋 |
| Sprint 7 | `security-mcp-server` + `security-agent` + `onboarding-agent` | 📋 |
| Sprint 8 | HiTL approval workflow (`ApprovalRequest` CRD) + Policy-as-Prompt | 📋 |
| Sprint 9 | Agent regression test suite + A/B prompt testing | 📋 |
| Sprint 10 | Slack bot + IDE plugin (VS Code) | 📋 |

---

## Phase 7c — Amazon Bedrock AI Integration 💡

**Goal:** Evolve the AI platform from direct Anthropic API calls to AWS-native Bedrock, enabling IRSA-based auth (no API key secrets), managed RAG, content guardrails, and richer agentic workflows — all additive to the existing KAgent stack.

| Item | Priority | Notes |
|------|----------|-------|
| Bedrock ModelConfig for KAgent | 🔴 High | Add a `ModelConfig` CRD pointing to Bedrock (`us.anthropic.claude-haiku-*`); KAgent routes via IRSA — no `kagent-anthropic` secret needed. Files: `kubernetes/kagent/modelconfig.yaml`, `bootstrap-ai.sh` |
| Bedrock Knowledge Base (replace pgvector RAG) | 🔴 High | Swap Voyage AI + pgvector (`idpRagSearch.ts`) for Bedrock KB backed by the existing S3 TechDocs bucket; Titan Embeddings handles chunking. AWS-only; local Kind path unchanged |
| Bedrock Guardrails | 🟡 Medium | Content filtering + PII masking + topic blocking on all AI assistant prompts; maps to AI Platform Scorecard Gold tier governance checks. Add guardrailIdentifier to ModelConfig CRD and Terraform resource |
| `idp:bedrock-generate` scaffolder action | 🟡 Medium | New Backstage backend module that calls Bedrock Claude to generate boilerplate from a natural-language description inside any template (model selectable: Haiku/Sonnet). File: new `idpBedrockGenerate.ts` |
| Bedrock Agents with Action Groups | 🟡 Medium | Standalone Bedrock Agent (Lambda action groups wrapping the 6 IDP MCP tools) exposed via API Gateway + Backstage proxy; AWS-native alternative/complement to KAgent. New `aws/bedrock/` Terraform directory |
| Event-driven auto-remediation | 🟡 Medium | K8s events → EventBridge → Lambda → Bedrock Agent → GitHub issue / PagerDuty. Agent diagnoses using CloudWatch Logs Insights before acting. No KAgent dependency |
| Bedrock Inline Agent for IaC plan review | 🟢 Low | Ephemeral (stateless) Bedrock agent invoked in CI before `terraform apply`; flags destructive changes, estimates cost delta, checks OPA policies. Integrates into `ci.yml` |
| Bedrock Flows for multi-step workflows | 🟢 Low | Visual workflow: scaffold → CI trigger → deploy → health check → notify. Replaces ad-hoc polling in `idpLocalDeploy.ts` with a managed state machine. New `aws/bedrock/flows/` Terraform |
| Bedrock multi-agent supervisor | 🟢 Low | Supervisor Bedrock Agent routing to sub-agents (deploy, QA, cost) via Bedrock's native multi-agent orchestration; single developer entry-point |
| Bedrock Model Evaluation | 🟢 Low | Benchmark Claude Haiku vs Sonnet on the 6 IDP tool-use scenarios using a curated S3 prompt dataset; results feed into the AI Platform Scorecard |

> **Dependency:** Items requiring IRSA assume Phase 10a TLS + IAM hardening is in place. The Bedrock ModelConfig item can ship independently on EKS as soon as IRSA is configured.

---

## Phase 7b — Test Automation Golden Path ✅

**Goal:** Every team has a one-click path to add any layer of the test pyramid to an existing service, with CI wired automatically.

| Item | Status | Notes |
|------|--------|-------|
| Unit test suites (Go, Node.js, Python) | ✅ | Language skeletons include tests; `unit-test-suite` template for brownfield |
| Component test suite (WireMock) | ✅ | `component-test-suite` — stubs deps, runs in CI |
| Integration test suite (Testcontainers) | ✅ | `testcontainers-suite` — real Postgres/Kafka in CI |
| Contract testing (`enable-contract-testing`) | ✅ | MCP-driven preferred path; `pact-contract-suite` / `contract-testing-suite` as legacy |
| E2E suites | ✅ | `playwright-e2e-suite`, `newman-api-suite`, `bdd-cucumber-suite` |
| Performance suite (k6) | ✅ | `k6-performance-suite` |
| Security DAST suite (ZAP) | ✅ | `zap-dast-suite` |
| Visual regression suite | ✅ | `visual-regression-suite` |
| Accessibility suite | ✅ | `accessibility-suite` |
| Mobile suite (Appium) | ✅ | `appium-mobile-suite` |
| Chaos suite (Chaos Mesh) | ✅ | `chaos-mesh-suite` |
| LLM eval suite (DeepEval) | ✅ | `deepeval-llm-eval-suite` |
| Mutation testing suite | ✅ | `mutation-testing-suite` |
| Synthetic monitoring suite | ✅ | `datadog-synthetic-suite` |
| IaC test suite | ✅ | `iac-test-suite` — tflint + Checkov + optional Terratest |

---

## Phase 8 — Developer Experience 📋

**Goal:** Reduce the time between "I wrote code" and "I see it running with full observability"
to under 10 minutes.

| Item | Priority | Notes |
|------|----------|-------|
| DORA metrics Backstage widget | ✅ | Per-component DORA tab with 4 cards, sparklines, and Elite/High/Medium/Low badges; see [docs/dora-finops.md](dora-finops.md) |
| Trivy results in Backstage | 🟡 Medium | Post-CI Trivy JSON → catalog entity; security tab shows CVE count per service |
| External Secrets Operator full loop | 🟡 Medium | `idpProvisionSecret` extended to emit `ExternalSecret` CRD; automatic rotation every 30 days |
| Platform CLI (`platformctl`) | 🟡 Medium | Go CLI wrapping `create-service.sh`, `setup-runner.sh`; `--help` + shell autocomplete |
| ECR repository provisioner | 🟢 Low | `idp:provision-ecr` scaffolder action; creates ECR repo + lifecycle policy + IRSA |
| Namespace provisioner action | 🟢 Low | `idp:create-namespace` for fast-path team onboarding |

> **Note on ephemeral PR environments:** Moved to backlog. Namespace lifecycle management,
> wildcard ingress DNS, and concurrent-PR race conditions make this a Phase 9+ item in practice.

---

## Phase 9 — Advanced Platform 💡

**Goal:** Platform is self-healing, cost-attributed, and secure by default at scale.

| Item | Status | Notes |
|------|--------|-------|
| Network policies cluster-wide | 💡 | Default-deny + explicit allow; Cilium or Calico |
| Ephemeral PR environments | 💡 | PR label `env: preview` → Helm install into `services-preview-<pr#>`; torn down on close |
| **Multi-region / HA** | ✅ | Active-standby eu-central-1 (primary) + us-east-1 (standby); see `feat/v2-multi-region` branch and [docs/multi-region.md](multi-region.md) |
| AI/ML platform namespace | 💡 | `ml-platform` namespace; GPU node group in Terraform; `LimitRange` for GPU quota |
| LLM gateway resource | 💡 | Anthropic Claude API (all envs); AI agent templates `dependsOn: resource:claude-api` |
| Chaos engineering integration | 💡 | Chaos Mesh; `chaos-experiment` Backstage template |
| Platform API (FastAPI) | 💡 | REST API for programmatic service creation |
| Backstage plugin: security posture | 💡 | Aggregate Trivy + OPA pass/fail per service into a single security score |

---

## Phase 10 — Multi-Team Scale & Production Hardening 📋

**Goal:** Harden the platform for use by 25+ production teams. This phase addresses the gaps
identified in the production-readiness assessment: TLS, high availability, per-team isolation
in ArgoCD, observability completeness, infrastructure right-sizing, and CI security gates.

### 10a — Security Hardening (Blockers)

| Item | Priority | Notes |
|------|----------|-------|
| TLS on all ingresses | 🔴 High | Deploy cert-manager; add `tls:` sections to all ingress resources in `aws/ingress/` |
| Backstage auth: disable guest + production mode | 🔴 High | Set `auth.environment: production`, remove guest provider, configure real GitHub OAuth (`backstage/app-config.yaml:65–82`) |
| PostgreSQL SSL strict mode | 🔴 High | `rejectUnauthorized: true` in `kubernetes/backstage/configmap.yaml:43` |
| K8s API TLS verification | 🔴 High | `skipTLSVerify: false` + CA bundle in `backstage/app-config.yaml:302` |
| Pin Backstage image tag | 🔴 High | Replace `:latest` with pinned SHA in `kubernetes/backstage/deployment.yaml:19`; violates repo's own OPA policy |
| Secret scanning in CI | 🔴 High | Add Gitleaks or GitHub secret scanning workflow to `.github/workflows/` |
| SAST scanning in CI | 🟡 Medium | Add CodeQL or Semgrep workflow to `.github/workflows/` |
| Pin GitHub Actions to commit SHAs | 🟡 Medium | Replace `@v4`/`@v5` refs with full commit SHAs (supply-chain risk) |

### 10b — High Availability

| Item | Priority | Notes |
|------|----------|-------|
| Backstage: scale to 3+ replicas | 🔴 High | `kubernetes/backstage/deployment.yaml` — add replicas, PodDisruptionBudget, anti-affinity |
| ArgoCD HA mode | 🔴 High | `aws/argocd/argocd-helm-values.yaml` — replicaCount ≥ 3 for server, repo-server, applicationSet |
| PodDisruptionBudgets | 🟡 Medium | Add PDB manifests for Backstage, ArgoCD, and monitoring stack |
| Enable HPA by default | 🟡 Medium | `helm/service-template/values.yaml:75` — set `autoscaling.enabled: true` with 70% CPU target |
| Multi-NAT Gateway | 🔴 High | Remove `single_nat_gateway = true` in `terraform/vpc.tf:24`; add per-AZ NAT GW for HA |

### 10c — Per-Team Platform Isolation

| Item | Priority | Notes |
|------|----------|-------|
| ArgoCD AppProject per team | 🔴 High | Scope each team to their own namespace/repos; prevent cross-team app access |
| ArgoCD RBAC per team | 🟡 Medium | `argocd-helm-values.yaml` — `role:team-<name>` policy scoped to AppProject |
| Rate limiting on Backstage | 🟡 Medium | Add request throttling (reverse proxy or middleware) to prevent portal abuse |
| Catalog permission policies | 🟡 Medium | Configure Backstage permission plugin; restrict catalog writes to team owners |
| GitOps-driven namespace provisioning | 🟢 Low | Manage team namespaces via ArgoCD app-of-apps rather than manual `kubectl apply` |

### 10d — Observability Completeness

| Item | Priority | Notes |
|------|----------|-------|
| Log aggregation | 🔴 High | Deploy Loki or enable CloudWatch Logs; metrics alone are insufficient for debugging |
| PagerDuty escalation | 🟡 Medium | Add PagerDuty receiver in `observability/alertmanager/alertmanager-config.yaml` for on-call escalation |
| Per-team Slack alert routing | 🟡 Medium | Route alerts to `#<team>-alerts` channel in addition to `#platform-alerts` |
| Backstage + ArgoCD ServiceMonitors | 🟢 Low | Extend `kubernetes/monitoring/servicemonitor.yaml` to cover platform components |

### 10e — Infrastructure Right-Sizing

| Item | Priority | Notes |
|------|----------|-------|
| Upgrade RDS instance class | 🟡 Medium | `terraform/rds.tf:44` — `db.t3.micro` → `db.t3.small` minimum; enable Multi-AZ failover |
| Upgrade EKS node types | 🟡 Medium | `terraform/variables.tf` — `t3.medium` → `t3.large`/`m5.large`; add memory-optimised node group |
| Cluster backup with Velero | 🟡 Medium | Protect PVCs, Grafana dashboards, and ArgoCD state; test restore procedure |
| Extend RDS backup retention | 🟢 Low | Increase from 7 days to 30 days in `terraform/rds.tf` |

### 10f — Developer Quality Gates

| Item | Priority | Notes |
|------|----------|-------|
| Integration tests for scaffold actions | 🟡 Medium | Add `.test.ts` files for all 8 modules in `backstage/app/packages/backend/src/modules/` |
| Test coverage threshold in CI | 🟢 Low | Fail CI when coverage drops below 70%; configure in Jest/go test |
| Disaster recovery runbook | 🟡 Medium | Document RTO/RPO targets; tested RDS restore + cluster rebuild procedure |

---

## Backlog 💡

| Feature | Notes |
|---------|-------|
| Secret rotation template | Backstage template wrapping `idp:provision-secret` with rotation schedule UI |
| ~~Multi-region / HA~~ | ✅ Shipped in `feat/v2-multi-region` — see [docs/multi-region.md](multi-region.md) |
| Cilium Cluster Mesh | Cross-cluster DNS + direct pod routing; deferred after Phase 1 traffic layer stable |

---

## Milestones

| Milestone | Target | Phase | GitHub Label |
|-----------|--------|-------|--------------|
| M0: Open-source ready | Q2 2026 | Phase 0 | `milestone/m0-oss-ready` |
| M1: Live CD | Q2 2026 | Phase 1 | `milestone/m1-live-cd` |
| M2: Ops-ready platform | Q2 2026 | Phase 2 | `milestone/m2-ops-ready` |
| M3: Cost-aware platform | Q2 2026 | Phase 3 | `milestone/m3-finops` |
| M4: Developer excellence | Q2 2026 | Phase 4 | `milestone/m4-scorecards` |
| M5: OSS launch | Q2 2026 🚧 | Phase 5 | `milestone/m5-oss-launch` |
| M6: Multi-env GitOps | Q3 2026 | Phase 6 | `milestone/m6-gitops` |
| M7: AI/ML platform | Q2 2026 ✅ | Phase 7 | `milestone/m7-aiml` |
| M7b: Test automation golden path | Q2 2026 ✅ | Phase 7b | `milestone/m7b-test-golden-path` |
| M7c: Amazon Bedrock AI integration | Q4 2026 | Phase 7c | `milestone/m7c-bedrock` |
| M8: Developer experience | Q3 2026 | Phase 8 | `milestone/m8-dx` |
| M9: Advanced platform | Q4 2026 | Phase 9 | `milestone/m9-advanced` |
| M10: Multi-team production scale | Q3 2026 | Phase 10 | `milestone/m10-scale` |

---

## GitHub Project Setup

This roadmap is designed to sync directly with a **GitHub Project (Roadmap view)**:

### Labels to create
```
priority/high    — #d93f0b
priority/medium  — #e4e669
priority/low     — #0075ca
phase/0-oss-ready
phase/5-oss-launch
phase/6-gitops
phase/7-aiml
phase/7c-bedrock
phase/8-dx
phase/9-advanced
```

### Recommended workflow
1. Create one GitHub Issue per roadmap row (use the item title + notes as the issue body)
2. Assign the matching `phase/*` and `priority/*` labels
3. Set the GitHub Milestone to the matching `M*` milestone
4. In the GitHub Project, add a **Roadmap** (timeline) view grouped by Milestone
5. Set start/due dates on each issue to place items on the timeline

### Suggested issue template for roadmap items
```markdown
## Summary
<!-- Copy the Notes column from roadmap.md -->

## Acceptance criteria
- [ ] Implementation complete
- [ ] Tests / verification steps pass (see roadmap.md Verification section)
- [ ] roadmap.md status updated to ✅

## Phase
<!-- e.g. Phase 6 — Multi-Environment GitOps -->

## References
<!-- Links to relevant files, ADRs, or prior issues -->
```
