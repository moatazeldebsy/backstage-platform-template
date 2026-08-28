# Engineering Intelligence — Roadmap

Thirteen phases. Each one names its data blocker, because on this platform the
blocker is almost never the code.

**Shipped: phases 0–7.**

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

## Phase 2 — Maturity model ✅

The [five levels](maturity-model.md) computed from dimension scores, served at
`GET /maturity` and carried on every `HealthReport` so snapshots record the level.
Levels are floors, not averages; the walk stops at the first level not fully met;
a dimension with no evidence yields *unconfirmed above N* rather than a guess;
and a definite failure outranks missing evidence.

Level 4 requires a Developer Experience score, so most installations report
*unconfirmed above Level 3* until phase 5. Level 5 declares two requirements no
collector supplies — enforced approval gating and measured agent remediation —
so it is structurally unconfirmable rather than merely unmet.

## Phase 3 — Engineering Intelligence dashboard ✅

`/engineering-intelligence` in Backstage: overall score, maturity headline, the
seven dimension cards, an expandable evidence table per dimension, top risks, the
five-level ladder, and evidence gaps in their own section.

It is **the first custom frontend plugin in this repo to live outside
`extensions.tsx`** — `packages/app/src/engineeringIntelligence/`, registered in
`App.tsx`'s `features` array. Its pure presentation logic sits in `present.ts`
with tests next door that run in milliseconds, rather than being unreachable
inside a 7,700-line module.

It **aggregates rather than duplicates**: each dimension card links to the page
that already owns its detail (`/scorecard`, `/slo`, `/finops`, `/dora`,
`/langfuse`) instead of redrawing those series.

And it has **no demo mode**. A failed request renders as an error, not as a
plausible dashboard — the one place in this app where that convention is
deliberately broken, for the reason in
[ADR-0006](../design/adr-0006-engineering-intelligence.md).

## Phase 4 — Platform Engineering intelligence ✅

`GET /platform` returns the breakdown behind the Platform score — service count,
ownership, golden-path adoption, template usage ranked by use, self-service
outcomes, and **the named services that are not on a golden path**. Surfaced as
a Platform Health card on the dashboard.

One new scored signal: **`scaffolder.taskSuccessRatio`**, read from the
scaffolder's `/v2/tasks` API rather than its database — the task rows live in a
schema Backstage does not treat as public. Adoption says how many services came
from a template; this says whether the scaffolder *works* when someone uses it.
A cancelled task counts as neither success nor failure.

Counts are reported, never scored. "642 services" is not better than "300", and
inventing a curve for it would assert a judgement the platform cannot support.

## Phase 5 — Developer Experience intelligence ✅

The dimension that had nothing behind it now has three series, published by the
DORA exporter CronJob the platform already runs:

| Series | From |
|---|---|
| `devex_pr_cycle_time_hours` | Pull request opened → merged |
| `devex_ci_duration_minutes` | CI run created → finished, **queue time included** |
| `devex_build_failure_ratio` | Failed runs over runs that reached a verdict |

CI metrics come from the workflow runs the exporter already fetches — zero extra
API calls, and across all branches, because developers wait on pull-request CI
too. Only the pull-request query costs a call, and it is bounded to one page:
the pulls API has no `since` filter, so an unbounded walk would burn the rate
limit for a mean a recent sample already answers.

Three deliberate choices worth knowing:

- **A series is omitted, never zeroed**, when nothing merged or nothing ran. The
  scoring engine reads an absent sample as reduced coverage but a zero as a real
  measurement — pushing 0.0 would claim instant CI and a flawless build.
- **Cancelled runs are excluded** from build failure ratio, unlike change
  failure rate which counts them. A cancelled run is usually a person changing
  their mind, not the build breaking.
- **PRs closed without merging are excluded** from cycle time. Abandoning a
  change is not a slow review.

The two exporters are a known drift pair and cannot share a module — each ships
as a single-file ConfigMap — so `observability/tests/test_dora_devex.py` runs
every assertion against both copies and compares them directly. That suite is
now a CI gate; before it, `py_compile` was the only thing checking these files.

**Not collected:** review latency (time to first review). It needs a per-PR call
to `/pulls/{n}/reviews`, and the rate-limit cost was not worth it for a first
cut. Adding it is a contained change to the same two functions.

## Phase 6 — AI Engineering readiness ✅

A second scored model at `GET /ai-readiness`, over twelve areas, rendered as an
AI Engineering Readiness card on the dashboard.

It reuses the same scoring engine rather than reimplementing it — the scoring
functions are generic over their area id, so there is one implementation of
normalisation, coverage, evidence and the insufficient-evidence rule serving two
models. That is the whole lesson of the Bronze/Silver/Gold scorecard, which
exists three times in this repo and has drifted.

| Area | Source |
|---|---|
| Governance | `ai.modelCardRatio` — Tech Insights |
| Evaluation | `ai.evalSuiteRatio` — Tech Insights |
| Observability | `ai.observabilityWiredRatio` + `ai.observabilityActive` — Tech Insights, Langfuse |
| Model management | `ai.modelVersionedRatio` — **MLflow registry (new collector)** |
| Prompt management | `ai.promptsManagedRatio` — **Langfuse prompts (new)** |
| Reliability | `ai.mcpToolSuccessRatio` — Prometheus |
| Security, Privacy, Architecture, Testing, Cost, Incident management | **nothing** |

The three AI-governance facts were split apart: the health model keeps its
blended `ai.governanceChecksRatio`, while readiness reads model card, eval suite
and observability separately — averaging them hides which one is missing.

Two deliberate refusals. **Model quality is not scored**: MLflow holds run
metrics, but a good accuracy figure on an unknown dataset says nothing about
production readiness. **Architecture will never have a collector** — it is a
judgement, and inventing a proxy for it would be the most dishonest number on
the page, so it says it needs human review rather than pointing at a future phase.

Six of twelve areas are unmeasurable and reported as such, excluded from the mean
rather than counted as zero. `Evaluation` carries a caveat that it observes suite
*presence*, not results — a service whose evals all fail scores the same as one
whose evals all pass. Closing that is phase 7.

## Phase 7 — AI quality and evaluation ✅

Turns "an evaluation suite exists" into "here is what it found", closing the
caveat phase 6 had to carry.

`packages/engineering-intelligence-core/src/evaluation.ts` is the abstraction —
**not a testing platform**. Nothing in it runs an evaluation or defines a good
one; it reads results a harness already produced and organises them by *risk*:
correctness, hallucination, policy compliance, PII safety, prompt injection,
bias, regression, latency, cost.

The extension point is one table, `METRIC_CATEGORIES`. A new evaluation library
is taught by appending patterns there; the collector, the scoring signals and the
dashboard all work off categories. Ordering in that table is load-bearing —
specific risks match before generic words, so `PromptInjectionCorrectness` is a
security failure rather than an accuracy dip.

The collector reads Langfuse **scores**, reversing what `push_to_langfuse.py`
writes: a NUMERIC score named for the metric and a BOOLEAN `<metric>_pass`,
paired on trace id so repeated assertions of one metric stay separate.

What phase 7 unlocks in the readiness model:

| Area | Before | After |
|---|---|---|
| Evaluation | suite presence, caveated | pass rate (weight 0.7) + presence (0.3) |
| Privacy | not collected | `ai.evalPiiSafetyRatio` |
| Security | not collected | `ai.evalPromptInjectionRatio` |
| Testing | not collected | `ai.evalRegressionRatio` |

Those three still report `insufficient-evidence` for an organisation that runs no
such suite — **an untested risk is unknown, not absent** — but the gap now names
an action rather than a future phase.

Two rules the tests pin. A category nobody evaluated produces no sample at all,
so PII safety can never read 100% because no PII test exists. And a metric no
pattern claims is surfaced in `uncategorised` rather than dropped, so a team
cannot add a suite, have it counted nowhere, and trust a dashboard that never
included it.

**Known limit, unchanged:** `push_to_langfuse.py` only reaches a *publicly
reachable* Langfuse. A GitHub-hosted runner cannot see the in-cluster service,
so on most installs there are no scores and `/evaluation` says so, naming that
reason rather than leaving a reader to wonder whether the suite is broken.

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
