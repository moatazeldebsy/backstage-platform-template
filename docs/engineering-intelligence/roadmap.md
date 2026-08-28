# Engineering Intelligence — Roadmap

Thirteen phases. Each one names its data blocker, because on this platform the
blocker is almost never the code.

**Shipped: phases 0 and 1.**

---

## Phase 0 — Architecture and product foundation ✅

Assessment of what already exists, and the four foundation documents:
[architecture](architecture.md), [product vision](product-vision.md),
[maturity model](maturity-model.md), [scoring](scoring.md), plus
[ADR-0006](../design/adr-0006-engineering-intelligence.md).

The assessment's three load-bearing findings: the scorecard is implemented three
times and has already drifted; Prometheus retains 6h locally and 30d on AWS with
no long-term store; and two of seven dimensions have no data source at all.

## Phase 1 — Engineering Health model ✅

The scoring engine (`packages/engineering-intelligence-core`), five collectors,
the snapshot store, and the API. Five dimensions score from real data; Security
scores with an explicit control-presence caveat; Developer Experience reports
`insufficient-evidence`.

## Phase 2 — Maturity model

Wire the [five levels](maturity-model.md) to the engine:
`GET /maturity` returning current level, target, gap and actions. Levels are
floors, not averages, and a dimension with no evidence yields *unconfirmed above
N* rather than a guess.

**Blocker:** none. The engine already produces everything this needs.

## Phase 3 — Engineering Intelligence dashboard

A Backstage page: overall score, the seven dimensions, top risks, recommended
actions. Executive-readable in thirty seconds, defensible under a follow-up.

**Blocker:** none, but a scoping decision. `extensions.tsx` is already 7,700
lines and holds a `/dora`, `/finops`, `/scorecard`, `/slo` and home page. The new
page must aggregate and link to those, not duplicate them — and should probably
be the first custom frontend plugin to live outside that file.

## Phase 4 — Platform Engineering intelligence

Deepen the Platform dimension: per-template usage, self-service creation rate,
service maturity distribution, deployment success rate.

**Blocker:** partial. Template usage is derivable from
`backstage.io/source-template`; scaffolder task history is in the scaffolder's
own database and has never been read for analytics.

## Phase 5 — Developer Experience intelligence

The dimension with nothing behind it. Needs a collector for PR cycle time, review
latency, CI duration and build failure rate.

**Blocker:** the data is reachable but nothing computes it. The GitHub API has
all of it, and `local/observability/dora/dora-exporter.py` already paginates
workflow runs — so the cheapest honest path is extending that exporter rather
than writing a fifth one. **This is the highest-value phase in the list**: until
it lands, the platform cannot answer "are developers actually benefiting?"

## Phase 6 — AI Engineering readiness

A dedicated readiness score across architecture, security, privacy, governance,
evaluation, observability, model management, prompt management, cost, testing,
reliability and incident management.

**Blocker:** partial. Governance, observability and evaluation are measurable
from Tech Insights, Langfuse and DeepEval. Model and prompt management are in
MLflow and Langfuse and unread. Cost is phase 8. Reuse Langfuse — do not build a
second AI observability stack.

## Phase 7 — AI quality and evaluation

An extensible evaluation model: correctness, hallucination, policy compliance,
PII leakage, prompt-injection resistance, regression, latency, cost, model
comparison.

**Blocker:** evaluation exists for exactly one agent suite
(`test-suites/test-deepeval/tests/test_idp_assistant.py`), pushed to Langfuse as
scores by `.github/workflows/eval.yml` — and that push no-ops against a
cluster-local Langfuse. Build the abstraction first; do not attempt a complete AI
testing platform.

## Phase 8 — AI / LLM FinOps

Cost by team, service, model, environment and request; token usage; trends;
savings recommendations.

**Blocker:** the hard one. Langfuse records cost and tokens per model and per
trace, but traces carry **no catalog or team attribution** — a name, a session id
and a user id, and nothing that joins back to an owning team. Per-team AI spend
cannot be computed until a join key is emitted at source in
`services/*/src/telemetry.ts`. Any such number before then is invented.

## Phase 9 — Engineering AI Advisor

Answer leadership questions against the Engineering Intelligence API: biggest
risks, why a score moved, what to focus on, which teams need attention.

**Blocker:** none technically — KAgent and the MCP servers are in place. The
constraint is design: the advisor reads the **structured** report, not raw source
data, and must cite the metric behind every claim. *"PR review time rose 31% over
30 days, correlating with PR volume in Team A"* is allowed; *"Team A is
understaffed"* is not, unless the data says so. Where evidence is insufficient it
must say so rather than fill the gap.

## Phase 10 — Executive reporting

A periodic report: overall score, what improved, what declined, top risks, top
recommendations.

**Blocker:** trend data. Snapshots begin at first install and there is no
back-fill, so "improved / declined" needs roughly a week of history before it
says anything. Do not over-engineer PDF generation in the first pass.

## Phase 11 — Benchmarking

Percentile comparison across organisations.

**Blocker:** deliberate. **Collect and transmit nothing external.** Build the
data model and the extension points only. Anonymisation and consent are product
decisions that precede any code.

## Phase 12 — Multi-tenancy foundation

Conceptual separation of Organisation → Teams → Services → Metrics → Scores →
Recommendations, so a hosted service would not require a fork.

**Blocker:** none, but scope discipline. The open-source project must stay fully
usable single-tenant, and no artificial limits are introduced. See
[ADR-0004](../design/adr-0004-identity-and-access.md) for the current
authorization model, which is coarse: any authenticated user can run any template.

---

## Cross-cutting debt this roadmap depends on

| Item | Why it matters |
|---|---|
| **Three scorecard implementations, already drifted** (gold = 9 in `scorecard.ts`, 10 in `exporter.py`) | Every quality and platform number inherits the ambiguity. Fixing it re-tiers live services, so it needs its own decision |
| **No long-term metric store** (6h local / 30d AWS, no Thanos/Mimir/AMP) | Every trend in phases 10–11 depends on snapshots accumulating from now |
| **Security is control-presence only** | The Security dimension cannot become a real risk measure until findings are trended |
| **Coverage and e2e pass rate are seeded demo values** | Excluded from scoring; a real exporter would strengthen Quality |

---

## Related

- [Architecture](architecture.md) · [Product vision](product-vision.md) ·
  [Maturity model](maturity-model.md) · [Scoring](scoring.md)
