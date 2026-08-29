# ADR-0006: Engineering Intelligence — where scoring lives, and what it refuses to score

**Status:** Accepted · **Date:** 2026-08-28 · **Updated:** 2026-08-29 (phases 6–12)

## Context

The platform is evolving from an Internal Developer Platform into an
**Engineering Intelligence Platform**: a layer that scores Platform Engineering,
Developer Experience, Quality, Reliability, AI Engineering, Security and FinOps
maturity and recommends what to improve. Phase 0 was an assessment of what the
repo already has before any of that was built. Three findings decided this ADR.

**The scoring layer already exists three times over.** The Bronze/Silver/Gold
scorecard is implemented in `backstage/app/packages/backend/src/modules/idpTechInsights.ts`
(as Tech Insights facts), again client-side in `backstage/app/packages/app/src/scorecard.ts`,
and a third time in Python in `observability/tech-insights-exporter/exporter.py`.
`scorecard.ts:7-12` acknowledges the first duplication in a comment and asks that
the two be changed together. They have nonetheless drifted: gold tier requires
**9** passing checks in `scorecard.ts:82-95` and **10** in `exporter.py:73`.
A service can therefore be Gold on its entity page and not Gold on the Grafana
dashboard, today, with no error anywhere.

**There is no long-term metric store.** Prometheus retention is **6 hours**
locally (`local/observability/prometheus-stack-values.yaml`) and **30 days** on
AWS. There is no Thanos, Mimir or AMP remote-write, and no recording rules for
any DORA, cost or scorecard series — every custom metric arrives as a
last-write-wins Pushgateway gauge from one of four Python CronJobs. Quarter-over-
quarter movement, which is most of what an executive engineering report is about,
cannot be reconstructed after the fact.

**Two of the seven dimensions have no data source at all.** Developer Experience
has nothing: no PR cycle time, no review latency, no CI duration, no build
failure rate, no onboarding timing, no CLI telemetry. Security has only
*annotation-presence* checks — `has-sonar-scanning` observes that a SonarCloud
annotation exists, never whether Sonar found anything. Dependabot alerts, Kyverno
PolicyReports and secret-rotation state are live-queried through
`security-mcp-server` and stored nowhere.

Against that, a strong house convention pulls the other way: every dashboard page
in `extensions.tsx` falls back to hardcoded demo data behind a yellow banner when
its source is unreachable (`DORA_DEMO`, `DEMO_LANGFUSE_*`, the FinOps demo rows).
That is a reasonable choice for a per-service tab on a template people evaluate
before installing anything.

## Decision

### 1. The scoring engine is a workspace package, not a fourth scorecard

Scoring lives in `backstage/app/packages/engineering-intelligence-core`, a
framework-free TypeScript package that imports nothing from Backstage. The
`engineering-intelligence` backend plugin collects samples and serves results;
the phase-3 dashboard and the phase-9 AI Advisor will read the same structures.

This is a new shape for the repo — no custom Backstage plugin has ever been
created here, and all custom code has so far lived inside `packages/app` and
`packages/backend`. The cost of the new convention is accepted because the
alternative is the failure the repo already has three instances of: a scoring
rule re-implemented per consumer, drifting silently.

### 2. It consumes Tech Insights facts; it never recomputes a check

`engineeringIntelligence/techInsights.ts` reads the `idp-entity-facts`
retriever's output and aggregates it. It contains no check logic. A fourth
implementation would be the worst of the four, because it would be the one
feeding an organisation-wide health score.

The 9-vs-10 gold threshold drift is **documented here and deliberately not fixed**.
Reconciling it re-tiers live services overnight and is a policy decision for the
scorecard owners, not a side effect of adding a dashboard.

### 3. Scores are persisted from the first refresh

Each refresh writes a full report to `ei_snapshots` in the plugin's own Postgres
database. This is the only place in the platform where a trend exists. There is
no back-fill and there cannot be one — no source retains the history.

### 4. Unmeasurable dimensions report `insufficient-evidence`, not a number

A dimension whose collected signals fall below its `minCoverage` returns
`score: null`, `status: "insufficient-evidence"`, and a `missing` list naming the
absent source. Developer Experience does exactly this today. Unscored dimensions
are excluded from the overall score rather than counted as zero.

This departs from the `extensions.tsx` demo-fallback convention, and the existing
pages keep their fallbacks unchanged. The distinction is audience: a fabricated
DORA sparkline on one service's tab is a placeholder, whereas a fabricated
"Engineering Health: 74" is the kind of number that reaches a board pack. The
`evidenceGaps` field is reported separately from `recommendations` for the same
reason — "we cannot measure this" is work on the platform's instrumentation, not
a finding about the engineering organisation.

Signals that measure something narrower than their name carry a `caveat` that
travels onto every evidence row. The security signal's reads:
*"Control presence, not finding count."*

### 5. Maturity levels are floors, and Level 5 is deliberately out of reach

The five-level model (`maturity.ts`) is computed from dimension scores, not from
the overall average — an average would place an organisation with strong
Reliability and no platform at Level 3. Levels are floors: the walk stops at the
first level not fully met, so high Level 4 scores cannot carry an unmet Level 2.

A dimension with `insufficient-evidence` can neither satisfy a requirement nor
fail one, making the level *unconfirmed above N*. A definite failure outranks
missing evidence, so a real shortfall cannot hide behind a data gap.

Level 5 declares two `capability` requirements that no collector supplies —
enforced approval gating, and agent remediation with a measured success rate — so
it is structurally unconfirmable rather than merely unmet. Nothing in the platform
observes whether the human-in-the-loop gate is actually enforced, and this
platform has had that gate found silently disabled before. Awarding "Autonomous
Engineering" from a high AI score would make exactly the claim there is no
evidence for.

Developer Experience gates Level 4 rather than Level 3, so most installations
report *unconfirmed above Level 3* until phase 5 lands.

### 6. Collectors read sources directly, never the Backstage UI layer

Targets are resolved from the `proxy.endpoints` already configured for the
frontend — the Backstage proxy is server-side, so the backend can reach
`prometheus.idp.local` and friends today, and no second address needs keeping in
step across two config overlays. A collector pointed at the UI layer would ingest
the demo fallbacks described above and score fiction as fact.

Every collector degrades to *no samples* on failure. None throws, and none
substitutes a default, so one dead source lowers the coverage of the dimensions
that depended on it and leaves the rest intact.

### 7. Evaluation categories are an extension point, not a hard-coded list

`METRIC_CATEGORIES` in `evaluation.ts` maps eval metric names to categories, and
its **ordering is load-bearing** — the first match wins, so a specific pattern
must precede a general one. Teams name eval metrics whatever they like, and a
closed enum would either reject those names or silently file them as "other".
A table that can be extended without touching the scorer keeps an unrecognised
metric visible as an uncategorised result rather than dropping it.

### 8. AI cost attribution derives its join key rather than waiting for one

Phase 0 recorded this as blocked: Langfuse traces carry no key joining back to a
catalog entity. That was wrong. Trace names already encode the workload —
`/a2a/<namespace>/<agent>` for agents and `<server>.<tool>` for MCP tools — so
`deriveWorkload()` parses the identity that is already there.

The cost of being wrong is bounded and visible: anything unparsed lands in
`unattributedUsd`, and `ai.costAttributedRatio` reports what fraction was
matched. A low ratio is a legible signal to fix naming at the emitting end,
which is better than the phase-0 plan of blocking the entire feature on a
telemetry change nobody had scheduled.

### 9. The advisor answers arithmetically, and its context is a reduction

`answer()` is deterministic. Every response is a lookup or a subtraction over the
report, because a model asked "why did the score drop?" could only agree with the
subtraction or contradict it — and only the second is a change in behaviour.

What the architecture provides instead is the safe input for a model:
`buildAdvisorContext()` strips evidence `labels` (user ids, raw trace names),
drops `unmatchedNames` (uncontrolled text written by whatever emitted a trace)
and reduces AI spend to team totals. `unsupportedCitations()` then rejects any
answer citing a metric outside the context's vocabulary.

Three refusals are properties of the **data**, not of the implementation, and a
model does not make them go away: no per-team ranking (nothing here is per-team),
no trend without two snapshots (retention is 6h/30d and history cannot be
back-filled), and no saving figure (nothing measures workload complexity).

### 10. Benchmarking ships as a data model that transmits nothing

Comparing an organisation against others requires consent, an anonymisation
guarantee somebody is accountable for, and a decision about who holds the data.
Those are product questions that precede code, and shipping a working uploader
first is how a platform ends up exfiltrating engineering metrics by default.

What ships is the shape: `toSubmission()` reduces a report to seven scores, a
maturity level and a day-precision date — no names, no evidence, no sources, and
no exact timestamp, because an exact timestamp is a correlation key across
submissions. It is pure and tested, so the claim that nothing identifying would
leave is checkable by reading one function. `MIN_COHORT_SIZE` is enforced in this
package rather than trusted to a future provider.

### 11. Single-tenant is the one-organisation case, not a special path

`DEFAULT_ORGANISATION` is a **real organisation id, not a null**. Rows written
today carry it and need no migration if a second organisation ever appears, and
there is no `if (multiTenant)` branch to keep working. `scopeFrom()` ignores a
stray scope parameter rather than erroring, so a leftover query string on a
single-tenant install does nothing instead of producing an error page.

Nothing here gates a feature on tenancy. The open-source platform has no
artificial limits.

### 12. A headline score is withheld below a third of the model

`MIN_SCORED_FRACTION = 1/3`. Applied to both Engineering Health and AI Readiness.

This came from a live cluster showing **"AI Engineering Readiness 97 / 100"**
derived from one measurable area out of twelve. Each individual area was scored
correctly; the average was arithmetically right and completely misleading,
because averaging one number is not averaging. A headline figure implies breadth
it did not have.

Below the floor the score is `null` and the UI states why — *"no overall score —
too little of the model is measurable"* — rather than rendering a bare dash that
reads as a rendering fault. Per-area scores stay visible; only the claim that
they summarise something is withheld.

## Consequences

- On a fresh install the report is mostly `insufficient-evidence`, and
  `catalog.goldenPathAdoption` is honestly near zero until services are
  scaffolded — the platform's own catalog entities are hand-written YAML with no
  `backstage.io/source-template` annotation. This reads as unflattering and is
  correct.
- Trends are unavailable for roughly the first week of running. There is no way
  to make them available sooner.
- The Dockerfile now needs a manifest line per workspace package, and the
  backend's own `config.d.ts` must be copied into the runtime image — the same
  boot-time crash the existing `packages/app/config.d.ts` copy step guards
  against.
- Adding a check to `idpTechInsights.ts` still requires the matching change in
  `scorecard.ts` and `exporter.py`. This ADR does not fix that; it only declines
  to make it worse.

- Upstream sources can publish a number they should have omitted, and no unit
  test catches it: the collector parses correctly and the scorer scores
  correctly. Two instances were found only by comparing output against a live
  cluster — a never-deployed repo scoring as elite reliability, and unattributed
  spend scoring as perfect budget discipline. Both are now guarded in
  `prometheus.ts`, and the class is documented in `integrations.md` because the
  next collector author will meet it again.
- Applying `MIN_SCORED_FRACTION` lowered a headline number that had previously
  looked good. Every such correction in this subsystem has moved a score
  downward, which is the expected direction when the prior number was borrowing
  confidence from data that did not exist.

## Deferred

- **Reconciling the three scorecard implementations** onto the core package.
  Correct end state, crosses a Python/TS boundary, and re-tiers live services.
- **Security findings as opposed to security controls.** Needs an exporter that
  turns Dependabot, Kyverno and Trivy results into a trended series.
- **SLO signals.** Sloth rules exist for `hello-service` alone, so a
  platform-wide SLO score would describe one service and imply it described all
  of them.
- **Quality Engineering has no test signals.** `idp_test_*` requires a
  `test-results` JUnit artifact; the template's CI uploads `go-coverage`
  instead, so the dimension reports `insufficient-evidence` on a live platform.
- **MLflow, Langfuse prompts, Langfuse scores and AI cost are fixture-tested
  only.** The AI stack does not fit in local capacity, so those four collectors
  have never run against a live source.
- **Wiring a model into the advisor.** The context boundary and citation
  guardrail exist; the generation step does not.

## References

- `docs/engineering-intelligence/architecture.md` — current and target architecture
- `docs/engineering-intelligence/scoring.md` — the evidence contract
- `docs/engineering-intelligence/maturity-model.md` — the five levels
- `docs/engineering-intelligence/roadmap.md` — phases and their data blockers
- `docs/engineering-intelligence/integrations.md` — collectors, sources and failure behaviour
- `docs/engineering-intelligence/ai-advisor.md` — the advisor's context boundary and refusals
- [ADR-0004](adr-0004-identity-and-access.md) — the authorization model these APIs inherit
