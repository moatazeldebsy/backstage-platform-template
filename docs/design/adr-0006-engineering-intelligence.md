# ADR-0006: Engineering Intelligence — where scoring lives, and what it refuses to score

**Status:** Accepted · **Date:** 2026-08-28

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

### 5. Collectors read sources directly, never the Backstage UI layer

Targets are resolved from the `proxy.endpoints` already configured for the
frontend — the Backstage proxy is server-side, so the backend can reach
`prometheus.idp.local` and friends today, and no second address needs keeping in
step across two config overlays. A collector pointed at the UI layer would ingest
the demo fallbacks described above and score fiction as fact.

Every collector degrades to *no samples* on failure. None throws, and none
substitutes a default, so one dead source lowers the coverage of the dimensions
that depended on it and leaves the rest intact.

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

## Deferred

- **Reconciling the three scorecard implementations** onto the core package.
  Correct end state, crosses a Python/TS boundary, and re-tiers live services.
- **Developer Experience collectors** (phase 5). The raw material is reachable
  through the GitHub API — `dora-exporter.py` already paginates workflow runs —
  but nothing computes or stores it.
- **Per-service and per-team AI cost attribution** (phase 8). Langfuse traces
  carry a name, a session id and a user id, but no key that joins back to a
  catalog entity or an owning team. The join key has to be added at the emitting
  end in `services/*/src/telemetry.ts` before any such number is more than a guess.
- **Security findings as opposed to security controls.** Needs an exporter that
  turns Dependabot, Kyverno and Trivy results into a trended series.
- **SLO signals.** Sloth rules exist for `hello-service` alone, so a
  platform-wide SLO score would describe one service and imply it described all
  of them.

## References

- `docs/engineering-intelligence/architecture.md` — current and target architecture
- `docs/engineering-intelligence/scoring.md` — the evidence contract
- `docs/engineering-intelligence/maturity-model.md` — the five levels
- `docs/engineering-intelligence/roadmap.md` — phases and their data blockers
- [ADR-0004](adr-0004-identity-and-access.md) — the authorization model these APIs inherit
