# Engineering Intelligence — Roadmap

Thirteen phases. Each one names its data blocker, because on this platform the
blocker is almost never the code.

**Shipped: all thirteen phases, 0–12.**

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

## Phase 8 — AI / LLM FinOps ✅

`GET /ai-cost`: spend by workload, by owning team and by model, with token
usage, over a 7-day window.

**The recorded blocker turned out to be half right.** This roadmap said per-team
AI spend needed a join key "added at the emitting end in
`services/*/src/telemetry.ts`". There is no *explicit* key — but a derivable one
is already being written:

```
KAgent agent turns   /a2a/kagent/platform-assistant   → platform-assistant
MCP tool calls       idp-mcp-server.catalog_search    → idp-mcp-server
```

Both are catalog Component names, so a trace joins to an owner and therefore a
team. No change to the emitting end was needed.

What keeps that honest rather than clever is the failure mode. The join is by
**naming convention, not a contract**, so spend whose trace name matches no
catalog entity is reported as an explicit **unattributed remainder** — never
dropped to make the columns add up, and never spread across the teams that
happen to be known. Parsing a name is also not the same as knowing who owns it:
a workload that parses but is absent from the catalog counts as unattributed too.

The scored signal is `ai.costAttributedRatio` — not how much you spend, but **how
much of the bill you can explain**. Spend itself is reported and never scored: a
team spending more is not doing worse.

This makes the readiness model's `cost` area measurable, leaving only
architecture and incident management with no collector at all.

**What is deliberately not here:** "move low-complexity summarisation workloads
to a lower-cost model, saving €2,140/month". That requires knowing a workload's
complexity, and nothing in this platform does. The recommendations stick to
attribution and model concentration — both facts on the page above them — and a
test asserts no advice ever names an invented saving.

## Phase 9 — Engineering AI Advisor ✅

`POST /advisor` with a question, answering from the structured reports.

Two things matter more here than a model call, and both are the deliverable.

**What an advisor is allowed to see.** `buildAdvisorContext` produces a
sanitised view: metric id, value and source per evidence row, and nothing else.
Evidence `labels` are dropped — that is where user ids, raw trace names and cost
strings live. AI spend is reduced to team totals; `byWorkload` and
`unmatchedNames` never appear, because a trace name is uncontrolled text written
outside the platform and has no business in a prompt. Tests assert the omissions
by serialising the context and searching it.

**What it is allowed to say.** `unsupportedCitations` rejects any claim citing a
metric absent from the context. It is deliberately mechanical — it judges whether
the thing pointed at exists, not whether the sentence reads well, so an invented
`devex.moraleIndex` is caught however plausible its surroundings.

**The answers are computed, not generated.** Every question here is a lookup or a
subtraction over the report. A model asked the same thing could only agree with
the arithmetic or contradict it, and the second is a bug. Where the data runs
out, the advisor says so:

> *"Which teams need attention?"* → Engineering Health is measured platform-wide,
> not per team, so this cannot be answered from it. The only per-team figure
> collected is AI spend — and that is a spend figure, not a performance one.

> *"Where can we reduce cost?"* → AI spend is $X over 7 days. **No saving figure
> is offered**: nothing here measures workload complexity, so any "move X to a
> cheaper model" estimate would be invented.

That refusal is the phase. "Team A is understaffed" is the canonical bad answer —
fluent, plausible, backed by nothing — and the design makes it unreachable rather
than merely discouraged.

## Phase 10 — Executive reporting ✅

`GET /report/executive`: overall score, maturity, what improved, what declined,
top risks with the evidence behind each, and what cannot be measured.

Improved and declined are split rather than presented as one signed list,
because they are read by different people for different reasons. The trend is
`null` with a stated reason until two scored snapshots exist — there is no
back-fill, and a report claiming "no change" on its first run would be inventing
a baseline.

No new collection and no figure that is not already on another endpoint: this is
a view over the snapshot history, not a second source of truth.

## Phase 11 — Benchmarking ✅ *(data model and extension points only)*

**Nothing is transmitted, and no implementation in this repo does.** That is the
phase, not an omission. Comparing an organisation against others needs consent,
an anonymisation guarantee somebody is accountable for, and a decision about who
holds the data — three product questions that precede any code. Shipping a
working uploader and asking afterwards is how a platform ends up exfiltrating
engineering metrics by default.

What ships is the shape:

- **`BenchmarkSubmission`** — the entire payload that would ever leave: seven
  scores, a maturity level, a schema version, and a date at *day* precision
  (an exact timestamp is a correlation key across submissions). No organisation,
  team or service names; no metric values, evidence or sources. `toSubmission` is
  pure and tested by serialising it and searching for what must not be there.
- **`MIN_COHORT_SIZE` and `placeOrWithhold`** — the anonymity floor, enforced in
  this package rather than trusted to each provider. In a cohort of three,
  "you are 33rd percentile" tells the other two exactly where everyone sits.
- **`BenchmarkProvider`** — the extension point, with `NO_BENCHMARK_PROVIDER` as
  the default, so "benchmarking is off" is a named state rather than a null check
  repeated at every call site.

An unscored dimension is omitted rather than submitted as zero: a cohort
averaging those zeros would conclude the industry is worse at Developer
Experience than it is, purely because few people measure it.

## Phase 12 — Multi-tenancy foundation ✅

Organisation → Teams → Services → Scores → Recommendations, named so a hosted
deployment would not require a fork.

The rule that keeps it honest: **`DEFAULT_ORGANISATION` is a real organisation,
not a null.** Single-tenant is the one-organisation case of the general model
rather than a special path beside it — so there is no second code path to keep
working, no `if (multiTenant)` branch to get wrong, and a row written today needs
no migration if a second organisation ever appears.

`scopeFrom` ignores an unrecognised scope parameter rather than throwing: on a
single-tenant install a stray `?organisationId=` should do nothing, not produce
an error page. `scopeKey` omits unset levels rather than rendering `undefined`
into a storage key.

**No artificial limits are introduced.** Nothing here gates a feature on tenancy,
and the open-source platform stays fully usable single-tenant.

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
