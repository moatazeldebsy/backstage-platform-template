# Engineering Intelligence — Architecture

Engineering Intelligence is a scoring layer over the telemetry this platform
already produces. It does not collect anything new in its first phase, and it
does not replace anything that exists.

This page covers the architecture as it stands, the target shape, and — most
usefully — an honest inventory of which data genuinely exists today.

---

## Current architecture (what Engineering Intelligence sits on)

**Backstage 1.50.4**, running the *new* frontend and backend systems:

| Layer | Shape |
|---|---|
| Frontend | `createApp` from `@backstage/frontend-defaults`; every upstream plugin imported from its `/alpha` entry point. All ~24 custom pages and ~12 entity tabs live in a single 7,700-line `packages/app/src/extensions.tsx`, exported as one `customPagesPlugin`. Nav is a `NavContentBlueprint` in `packages/app/src/modules/nav/Sidebar.tsx` that auto-includes any new page alphabetically |
| Backend | `createBackend()`; 19 files under `packages/backend/src/modules/`, mostly scaffolder actions, plus three full `createBackendPlugin` instances: `rag-search`, `learning-center`, and now `engineering-intelligence` |
| Storage | Postgres (`pgvector/pgvector:pg17` locally, RDS on AWS). Backstage's `PluginDatabaseManager` provisions a database per plugin. There are no knex migration directories — schema is created with idempotent `CREATE TABLE IF NOT EXISTS` inside `init()` |
| Integrations | 17 configured `proxy.endpoints`: OpenCost, Prometheus, Grafana, KAgent, MLflow, Langfuse, contract-mcp, approval-service, SonarCloud, Snyk, Datadog, GitHub issues, GitHub code scanning, PagerDuty, Jira, ArgoCD, GitHub Copilot |
| Observability | kube-prometheus-stack + Pushgateway. Four Python CronJob exporters push custom series: DORA, Tech Insights scorecard, flaky tests, catalog shape |
| AI | KAgent agents, eight MCP sidecars, MLflow, Langfuse for LLM tracing, DeepEval for agent evaluation in CI |

---

## Target architecture

```
Data sources        Prometheus · Catalog API · Tech Insights · OpenCost · Langfuse
                                         │
Collectors          one module per source, in
                    packages/backend/src/modules/engineeringIntelligence/
                    · reads the source directly, never the Backstage UI
                    · failure yields no samples — never a default, never a throw
                                         │
Metrics model       MetricSample { metric, value, source, observedAt }
                                         │
Scoring engine      packages/engineering-intelligence-core  ← no Backstage imports
                    normalise → weight → evidence → score → recommendations
                                         │
Snapshot store      ei_snapshots (Postgres, jsonb) — the platform's only trend store
                                         │
API                 /api/engineering-intelligence/*
                                         │
                    ┌────────────────────┴────────────────────┐
       /engineering-intelligence                AI Advisor (phase 9)
       (its own frontend plugin,
        links out to /dora, /finops,
        /scorecard, /slo, /langfuse)
```

The one architectural rule worth stating plainly: **the scoring engine imports
nothing from Backstage**. It is a plain TypeScript package that takes samples and
returns a report. That is what lets the dashboard and the AI Advisor read the
same scores instead of each growing a copy — the failure this repo already has
three instances of in its Bronze/Silver/Gold logic. See
[ADR-0006](../design/adr-0006-engineering-intelligence.md).

### Components

| Path | Role |
|---|---|
| `backstage/app/packages/engineering-intelligence-core/` | The engine. `model.ts` (types), `normalize.ts` (raw → 0–100), `dimensions.ts` (declarative scoring policy), `score.ts`, `recommend.ts`, `maturity.ts` (the five levels), `aiReadiness.ts` (the second scored model), `evaluation.ts` (evaluation results by risk category), `aiCost.ts` (spend attribution) |
| `backstage/app/packages/backend/src/modules/idpEngineeringIntelligence.ts` | The plugin: scheduling, persistence, HTTP routes |
| `.../modules/engineeringIntelligence/{prometheus,catalog,techInsights,opencost,langfuse,langfuseScores,aiCost,scaffolder,mlflow}.ts` | One collector per source |
| `.../modules/engineeringIntelligence/{collect,store,source}.ts` | Orchestration, snapshots, shared transport |
| `backstage/app/packages/app/src/engineeringIntelligence/` | The dashboard. `plugin.tsx` (page + nav item), `api.ts` (typed client), `present.ts` (pure display logic, tested), `EngineeringIntelligencePage.tsx` |

### API

All routes require an authenticated user; there is no unauthenticated surface.

| Route | Returns |
|---|---|
| `GET /api/engineering-intelligence/health` | The latest `HealthReport`, plus `evidenceGaps` |
| `GET /api/engineering-intelligence/dimensions/:id` | One dimension with full evidence and `missing` |
| `GET /api/engineering-intelligence/maturity` | Current level, whether it is confirmed, target level, gap and actions |
| `GET /api/engineering-intelligence/platform` | Platform Health breakdown: counts, template usage, and the named services off the golden path |
| `GET /api/engineering-intelligence/ai-readiness` | AI Engineering Readiness across twelve areas, scored by the same engine |
| `GET /api/engineering-intelligence/evaluation` | Evaluation results by risk category, with per-suite pass rates |
| `GET /api/engineering-intelligence/ai-cost` | AI spend by workload, team and model, with the unattributed remainder |
| `GET /api/engineering-intelligence/recommendations` | Ranked recommendations, each carrying its evidence |
| `GET /api/engineering-intelligence/snapshots?limit=` | Persisted history, for trends |
| `POST /api/engineering-intelligence/refresh` | Forces a collection |

### Configuration

`engineeringIntelligence` in `backstage/app/app-config.yaml` — base layer, since
the defaults hold for every target and the source addresses come from the
per-environment `proxy.endpoints`. Schema in `packages/backend/config.d.ts`.

```yaml
engineeringIntelligence:
  refreshMinutes: 30          # matches the techInsights fact cadence it reads
  sources: { prometheus: true, opencost: true, langfuse: true, catalog: true, techInsights: true }
  weights: { finops: 2 }      # optional; defaults to 1 per dimension
```

Langfuse needs `langfuse.publicKey` / `langfuse.secretKey` for server-side
collection — the frontend never holds these, because the proxy injects them.
Without them the AI observability signal reports *unavailable* rather than
assuming there are no traces.

---

## What data actually exists

This is the part worth reading before proposing a metric. Everything below was
verified against `main`.

| Dimension | Real data today | Where from |
|---|---|---|
| **Platform** | Ownership coverage, golden-path adoption (`backstage.io/source-template`), Gold-tier ratio, deploy frequency, scaffolder success rate | Catalog API, Tech Insights, `dora_deploy_frequency_per_day`, scaffolder `/v2/tasks` |
| **Quality** | Scorecard check pass ratio, test flakiness, test pass/fail counts | Tech Insights facts; `idp_test_*` from `observability/flaky-test-exporter/` |
| **Reliability** | Change failure rate, MTTR | `dora_change_failure_rate_percent`, `dora_mttr_minutes` |
| **FinOps** | Team budget utilisation, cost-weighted resource efficiency | `idp_team_budget_utilization_ratio`; OpenCost `/allocation/compute` |
| **AI Engineering** | Governance checks (model card, eval suite, AI observability), MCP tool success rate, whether LLM traces are flowing | Tech Insights; `mcp_tool_calls_total`; Langfuse `/api/public/metrics/daily` |
| **Security** | Whether Sonar/Snyk/Trivy scanning is *declared* | Tech Insights — **control presence, not findings** |
| **Developer Experience** | Deployment lead time, PR cycle time, CI duration, build failure rate | `dora_lead_time_minutes`, `devex_*` — all from the DORA exporter CronJob |

### What does not exist, and is therefore not scored

- **Review latency** (time to a pull request's first review). It needs a per-PR
  call to `/pulls/{n}/reviews`; the rate-limit cost was not worth it for a first
  cut. Environment provisioning time and onboarding timing are also unmeasured.
  The three DevEx metrics that *are* collected landed in phase 5.
- **Security findings.** Dependabot alerts, Kyverno PolicyReports and secret
  rotation are live-queried via `security-mcp-server` and never persisted. There
  are no `kyverno_*`, `trivy_*` or `gitleaks_*` series.
- **Code coverage and e2e pass rate.** Both appear on the QA Grafana dashboard,
  but the only thing that ever writes them is `scripts/seed-qa-metrics.sh` —
  they are demo values. Deliberately excluded from the Quality dimension.
- **SLO error budgets.** Sloth rules exist for `hello-service` alone.
- **AI cost attribution is convention-based.** Phase 8 joins a trace to a
  catalog entity through its *name*, which works for KAgent agents and MCP
  servers but breaks for any workload named differently. Unmatched spend is
  reported as an explicit remainder rather than guessed at.
- **Cloud spend outside Kubernetes.** No Cost Explorer or CUR integration.

### Two traps

**Metric names.** `docs/dora-finops.md` used to document `idp_deploy_frequency`,
`idp_lead_time_seconds`, `idp_change_failure_rate` and `idp_mttr_seconds`. Those
series do not exist — the real ones are `dora_deploy_frequency_per_day`,
`dora_lead_time_minutes`, `dora_change_failure_rate_percent` and
`dora_mttr_minutes`. The doc has been corrected; build from the exporter, not
from prose.

**Retention.** Prometheus keeps **6 hours** locally and **30 days** on AWS, with
no long-term store and no recording rules for any custom series. Pushgateway
gauges are last-write-wins. This is why the plugin persists its own snapshots
from the first refresh, and why no history can be back-filled.

---

## Verifying it

```bash
./scripts/verify-engineering-intelligence.sh --screenshot
```

Boots the real Backstage image against a real Postgres, with a stub standing in
for Prometheus and OpenCost, and asserts every figure the fixtures imply —
scores, evidence sums, the withheld dimensions, the maturity level, snapshot
persistence, and a 401 on an unauthenticated request. Roughly two minutes warm,
against ~19 for a cold `bootstrap-local.sh`.

It does **not** exercise real Prometheus or OpenCost response shapes. Those are
stubbed, and only a real cluster proves them — which is the one thing worth
running `bootstrap-local.sh` for.

On a real local install, expect several dimensions to report
`insufficient-evidence` at first, for honest reasons:

| Dimension | Needs |
|---|---|
| Quality | The Tech Insights retriever to have run — cadence is `*/30` |
| Reliability, Developer Experience | `GITHUB_TOKEN` in `local/.env` **and** repos carrying the `idp-app` topic. No scaffolded services means no `dora_*` or `devex_*` series at all |
| AI Engineering | `bootstrap-ai.sh --langfuse`, and `LANGFUSE_BASIC_AUTH` exported from the `langfuse-init` secret |
| Security | Nothing yet — it is control-presence only |

Golden-path adoption will also read near zero on a fresh install: the platform's
own catalog entities are hand-written YAML carrying no
`backstage.io/source-template`. That is correct, and it is what the number is
for.

## Related

- [Product vision](product-vision.md) · [Maturity model](maturity-model.md) ·
  [Scoring](scoring.md) · [Roadmap](roadmap.md)
- [ADR-0006](../design/adr-0006-engineering-intelligence.md) — the decisions above
- [Platform architecture](../architecture.md) — the layers this sits on
- [DORA & FinOps](../dora-finops.md) — the existing per-service tabs
