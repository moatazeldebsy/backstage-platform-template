# Screenshots

All shots are from live clusters — mostly a local Kind cluster brought up with `./scripts/setup.sh` + `./scripts/bootstrap-ai.sh`, plus a few from the AWS EKS path. No mock-ups.

> Some tabs show live data from third-party integrations (SonarCloud, Datadog, PagerDuty, …) that will be empty on a fresh install until you add your own credentials — see [Optional third-party integrations](local-setup.md#optional-third-party-integrations).

## The portal

The **Platform Dashboard** is the landing page: catalog counts, platform-wide DORA, and every service at a glance.

![Platform Dashboard](assets/screenshots/platform-dashboard.jpg)

| Software Catalog | Teams |
|---|---|
| ![Software Catalog](assets/screenshots/catalog-components.jpg) | ![Teams](assets/screenshots/catalog-teams.jpg) |
| Every service, API, MCP server and test suite, owned and tagged | 8 teams, each with its own namespace, SecretStore and Grafana folder |

Each entity page carries the platform's own tabs — TechDocs, Kubernetes, DORA, Scorecard, Security, Datadog, Trivy, SLOs:

| TechDocs on the entity | Scorecard on the entity |
|---|---|
| ![Entity TechDocs](assets/screenshots/entity-techdocs.jpg) | ![Entity Scorecard](assets/screenshots/entity-scorecard-gold.jpg) |

## Golden path — scaffold → repo → deploy

59 templates in the Scaffolder, filtered by category, tag or owner:

![Scaffolder templates](assets/screenshots/scaffolder-templates.jpg)

| Scaffolder task running | The repo it produced |
|---|---|
| ![Scaffolder task](assets/screenshots/scaffolder-task-run.jpg) | ![Scaffolded repo](assets/screenshots/scaffolded-repo-github.jpg) |
| Generate → push to GitHub → register in catalog → run the first job | CI workflow, Dockerfile, `catalog-info.yaml`, TechDocs — all wired |

Templates are wizards, not a wall of fields — and the last step opens the GitOps PR that puts the new service under ArgoCD:

| Template wizard (LLM App) | The GitOps PR it opened |
|---|---|
| ![LLM App template](assets/screenshots/template-llm-app-langfuse.jpg) | ![GitOps onboarding PR](assets/screenshots/gitops-onboarding-pr.jpg) |
| Model, effort level, trace sampling — chosen up front, wired into the skeleton | An ApplicationSet auto-discovers the service into `services-dev` on merge |

Self-service infrastructure is the same flow — a Crossplane Claim committed to Git instead of a Terraform PR:

![Crossplane templates](assets/screenshots/templates-crossplane.jpg)

| ArgoCD app-of-apps | Argo Rollouts canary |
|---|---|
| ![ArgoCD](assets/screenshots/argocd-applications.jpg) | ![Argo Rollouts](assets/screenshots/argo-rollouts-canary.jpg) |

## Shift-left quality

Bronze / Silver / Gold tiers across every service, with the cheapest unfilled check called out as the next action:

![Scorecard overview](assets/screenshots/scorecard-overview.jpg)

| SLOs and error budgets | QA platform metrics |
|---|---|
| ![SLOs](assets/screenshots/slos.jpg) | ![QA metrics](assets/screenshots/grafana-qa-metrics.jpg) |
| Sloth multi-window burn-rate, live from Prometheus | E2E pass rate, k6 p95 latency and error rate per run |

Those SLOs aren't hand-written YAML — a template generates the Sloth definitions and burn-rate alerts and opens the PR:

![Define Service SLOs template](assets/screenshots/template-define-slos.jpg)

## AI/ML platform and agents

The **AI Assistant** answers in plans, not prose — it maps your intent onto the actual templates on the platform and asks for exactly the inputs they need:

| Ask it anything | It plans the scaffold |
|---|---|
| ![AI Assistant](assets/screenshots/ai-assistant.jpg) | ![AI Assistant scaffold plan](assets/screenshots/ai-assistant-scaffold-plan.jpg) |

…and then it actually runs the scaffolder — repo, deploy target, task ID and the suggested next steps come back in the same chat:

![AI Assistant scaffold result](assets/screenshots/ai-assistant-scaffold-done.jpg)

| KAgent agents | MCP servers and model configs |
|---|---|
| ![KAgent](assets/screenshots/kagent-agents.jpg) | ![MCP servers](assets/screenshots/kagent-mcp-servers.jpg) |

The **MLflow** page gives experiment tracking and the model registry the same in-portal treatment — experiments, recent runs and registered models, read live from the MLflow API, without leaving the catalog:

![MLflow page in Backstage](assets/screenshots/mlflow-page.jpg)

| Agent Approvals (HiTL gate) | MLflow's own UI |
|---|---|
| ![Agent Approvals](assets/screenshots/agent-approvals.jpg) | ![MLflow UI](assets/screenshots/mlflow-experiment.jpg) |
| Every mutating agent action waits for a human — or an auto-approve policy | One click away at `mlflow.idp.local`, for the deep-dive views |

Semantic search over templates, components and TechDocs (Voyage AI + pgvector):

![AI Search](assets/screenshots/ai-search.jpg)

Prometheus tells you *that* an agent ran. **Langfuse** tells you what it cost — prompt and completion, tokens, latency and spend per run, without leaving the portal:

| AI Observability in Backstage | The full Langfuse UI |
|---|---|
| ![AI Observability](assets/screenshots/ai-observability-langfuse.jpg) | ![Langfuse cost dashboard](assets/screenshots/langfuse-cost-dashboard.jpg) |
| Cost and token usage per model, and recent agent runs with latency | Cost by model and environment, per-user spend, and trace drill-down |

## Observability, DORA and FinOps

| DORA metrics | FinOps cost overview |
|---|---|
| ![DORA](assets/screenshots/dora-metrics.jpg) | ![Cost Overview](assets/screenshots/finops-cost-overview.jpg) |
| Four keys platform-wide and per service, with performance bands | OpenCost spend by namespace, team or container |

| Cost Calculator | Grafana — IDP services |
|---|---|
| ![Cost Calculator](assets/screenshots/cost-calculator.jpg) | ![Grafana IDP services](assets/screenshots/grafana-idp-services.jpg) |
| Estimate a service's monthly cost *before* scaffolding it | Request rate, CPU/memory and restarts, filtered by catalog entity |

Incidents are records, not Slack threads — auto-filed from Alertmanager, severity-filtered, and feeding MTTR back into DORA:

![Incidents](assets/screenshots/incidents.jpg)

<details>
<summary><b>More screens</b> — Tech Radar, onboarding, Learning Center, API explorer, Copilot metrics, admin, activity feed, search, support</summary>

<br>

| Tech Radar (92 entries) | API Explorer |
|---|---|
| ![Tech Radar](assets/screenshots/tech-radar.jpg) | ![API Explorer](assets/screenshots/api-explorer.jpg) |

| OpenAPI spec on the entity | Onboarding |
|---|---|
| ![OpenAPI](assets/screenshots/api-openapi.jpg) | ![Onboarding](assets/screenshots/onboarding.jpg) |

| Learning Center | Copilot metrics |
|---|---|
| ![Learning Center](assets/screenshots/learning-center.jpg) | ![Copilot metrics](assets/screenshots/copilot-metrics.jpg) |

| Admin | Activity feed |
|---|---|
| ![Admin](assets/screenshots/admin.jpg) | ![Activity feed](assets/screenshots/activity-feed.jpg) |

| Search | Support |
|---|---|
| ![Search](assets/screenshots/search.jpg) | ![Support](assets/screenshots/support.jpg) |

</details>
