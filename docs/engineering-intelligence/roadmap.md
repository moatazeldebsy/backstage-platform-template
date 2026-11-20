# Engineering Intelligence — Roadmap

All fourteen planned phases (0–13) have shipped. This page lists what each one
delivered and the known limits and debt that remain.

## What shipped

| Phase | Delivered | Where |
|---|---|---|
| 0 | Foundation: [architecture](architecture.md), [product vision](product-vision.md), [maturity model](maturity-model.md), [scoring](scoring.md), [ADR-0006](../design/adr-0006-engineering-intelligence.md) | docs |
| 1 | Engineering Health model: scoring engine, five collectors, snapshot store, API | `packages/engineering-intelligence-core` |
| 2 | Five-level maturity model (levels are floors; missing evidence reads *unconfirmed above N*) | `GET /maturity` |
| 3 | Dashboard: score, maturity, dimension cards with evidence, top risks, evidence gaps. No demo mode — a failed request shows an error | `/engineering-intelligence` |
| 4 | Platform breakdown: ownership, golden-path adoption, template usage, scaffolder task success | `GET /platform` |
| 5 | Developer Experience series: PR cycle time, CI duration (queue included), build failure ratio | DORA exporter |
| 6 | AI Engineering readiness over twelve areas, on the same scoring engine | `GET /ai-readiness` |
| 7 | Evaluation results by risk (correctness, hallucination, PII, prompt injection, regression, …) read from Langfuse scores | `GET /evaluation` |
| 8 | AI spend by workload, team and model; scores *how much of the bill is attributable*, never the spend | `GET /ai-cost` |
| 9 | [AI Advisor](ai-advisor.md): answers computed from the reports, with a sanitised context and citation checking | `POST /advisor` |
| 10 | Executive report: improved, declined, top risks, unmeasurable areas | `GET /report/executive` |
| 11 | Benchmarking data model and extension points only — **nothing is transmitted** | `BenchmarkProvider` |
| 12 | Multi-tenancy foundation; single-tenant is the one-organisation case | `DEFAULT_ORGANISATION` |
| 13 | [DX Core 4](core4.md) view and the quarterly DevEx survey | `/core4`, `/devex-survey` |

## Known limits

- **Model quality and architecture are never scored.** Accuracy on an unknown
  dataset says nothing about production readiness, and architecture is a judgement.
- **Unmeasured areas are excluded, not zeroed.** An untested risk is unknown, not absent.
- **Evaluation scores need a reachable Langfuse.** A GitHub-hosted runner can't
  see an in-cluster one, so most installs report no scores and say why.
- **Review latency isn't collected** (it needs a per-PR API call).
- **No saving figures are offered** anywhere: nothing measures workload complexity.
- **Trends need two snapshots.** There is no back-fill.

## Cross-cutting debt

| Item | Why it matters |
|---|---|
| **Scorecard tier thresholds differ** (gold = 9 in `scorecard.ts`, 10 in `exporter.py`) | Check predicates are shared in `@internal/scorecard-core`; thresholds and the Python exporter are not, because reconciling them re-tiers live services |
| **No long-term metric store** — AWS keeps 3 days; local was raised 6h → 24h (`local/observability/prometheus-stack-values.yaml`) | Every trend depends on snapshots accumulating from now on |
| **Security is control-presence only** | It can't become a risk measure until findings are trended |
| **Coverage and e2e pass rate are seeded demo values** | Excluded from scoring until a real exporter exists |
