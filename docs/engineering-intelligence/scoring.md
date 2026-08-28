# Scoring

How a number gets produced, and what it is allowed to claim.

The engine lives in `backstage/app/packages/engineering-intelligence-core` and
imports nothing from Backstage. Scoring policy is declarative — the whole of it
is readable in `src/dimensions.ts` without running a collection.

---

## The pipeline

```
MetricSample          { metric, value, source, observedAt }
   │  normalise        raw units → 0–100, per src/normalize.ts
   │  weight           each signal's declared weight within its dimension
   ▼
Evidence              { metric, value, normalised, source, observedAt, impact, caveat? }
   │  sum
   ▼
DimensionScore        { score, status, coverage, evidence[], missing[] }
   │  weighted mean over scored dimensions only
   ▼
HealthReport          { overallScore, status, dimensions, recommendations }
```

### Normalisation

Four normalisers, in `src/normalize.ts`:

| Kind | Use |
|---|---|
| `linear` | Higher is better between a floor and a ceiling |
| `inverseLinear` | Lower is better (CI duration, flakiness, budget utilisation) |
| `ratio` | A 0–1 fraction read as a percentage |
| `banded` | Ordered thresholds — the DORA elite/high/medium/low bands |

All four clamp to 0–100 and map non-finite input to 0, so a malformed sample
cannot skew a dimension.

### Weighting and coverage

Each signal declares a weight within its dimension. The dimension score is the
weighted mean **over the signals that produced a sample**:

```
score = Σ (normalised × weight) / Σ (weight of signals present)
```

Dividing by the *present* weight rather than the total is the important part. A
signal that was not measured lowers `coverage`; it does not drag the score toward
zero. An absent measurement is not a bad one.

### The `insufficient-evidence` rule

Each dimension declares a `minCoverage` (currently 0.5 everywhere). Below it:

```json
{ "dimension": "devEx", "score": null, "status": "insufficient-evidence",
  "coverage": 0.25,
  "missing": [{ "metric": "devex.prCycleTimeHours",
                "expectedFrom": "github (not yet collected — phase 5)",
                "reason": "No sample was collected for devex.prCycleTimeHours." }] }
```

`score` is `null`, never a number. Unscored dimensions are **excluded** from the
overall score rather than counted as zero — counting Developer Experience as zero
today would understate overall health by roughly fourteen points and would keep
doing so until phase 5.

Whatever *was* measured is still returned, with `impact: 0`. The reader should be
able to see the shape of the gap, not merely be told there is one.

---

## The evidence contract

Three properties, each asserted directly in `src/score.test.ts`:

1. **Every evidence row carries a source and a timestamp.** A score whose
   evidence cannot be traced to a source and a moment is an assertion, not a
   measurement.
2. **Impacts sum to the score.** This is what makes a score explainable rather
   than asserted — add the evidence up and you land on the headline number.
3. **A signal's caveat travels onto its evidence.** A caveat that would embarrass
   the number if omitted belongs on the number.

```json
{
  "dimension": "security",
  "score": 60,
  "status": "ok",
  "coverage": 1,
  "evidence": [{
    "metric": "security.scanningControlsRatio",
    "value": 0.6, "normalised": 60,
    "source": "techInsights", "observedAt": "2026-08-28T09:00:00.000Z",
    "impact": 60,
    "caveat": "Control presence, not finding count. No vulnerability, policy-violation or secret-rotation data is trended anywhere in the platform."
  }],
  "missing": []
}
```

---

## Recommendations, and why they are not gaps

A signal whose normalised score falls below its declared `recommendBelow`
produces a `Recommendation` carrying the evidence row that triggered it. The
rules are deterministic and live beside the signal in `dimensions.ts`. No
language model is involved — the phase-9 AI Advisor reads these structured
recommendations rather than inventing its own from raw metrics.

Two rules govern what may be recommended:

- **Never from a signal that was not measured.** "We collected nothing for PR
  cycle time" and "PR cycle time is bad" are different statements, and conflating
  them invents a problem. Unmeasured signals appear in `evidenceGaps`, reported
  separately, because improving instrumentation is work on the platform rather
  than a finding about the organisation.
- **But do recommend from a real measurement inside an unscored dimension.**
  Withholding a dimension score says the aggregate cannot be summarised, not that
  nothing was observed. A 19% flakiness ratio stays actionable even when its
  sibling signals are missing.

Ranking is by severity, then by how far below its threshold the signal sits.

---

## Why the engine is a separate package

Because this repo already shows what happens otherwise.

The Bronze/Silver/Gold scorecard is implemented three times: as Tech Insights
facts in `packages/backend/src/modules/idpTechInsights.ts`, client-side in
`packages/app/src/scorecard.ts`, and in Python in
`observability/tech-insights-exporter/exporter.py`. `scorecard.ts:7-12` warns
about the first duplication in a comment. They have drifted anyway — gold
requires **9** passing checks in `scorecard.ts` and **10** in `exporter.py`, so a
service can be Gold on its entity page and not Gold on the Grafana dashboard,
with no error raised anywhere.

Engineering Intelligence therefore **consumes** Tech Insights facts and
recomputes no check. A fourth implementation would be the worst of the four,
because it would be the one feeding an executive health score. Reconciling the
existing three is tracked separately — it re-tiers live services and is a policy
decision, not a refactor.

---

## Extending it

Adding a signal is a change to `dimensions.ts` plus a collector that emits the
metric id. Nothing else needs touching.

```ts
{
  metric: 'devex.prCycleTimeHours',
  label: 'PR cycle time',
  weight: 0.3,
  normaliser: { kind: 'inverseLinear', min: 4, max: 120 },
  expectedFrom: 'github',
  recommendBelow: 60,
  recommendation: { severity: 'warning', action: 'Investigate review latency in the slowest repos.' },
}
```

Declaring a signal **before** its collector exists is deliberate and encouraged:
an uncollected signal is what produces an honest `missing` entry naming the
absent source, instead of a dimension quietly scoring well on the two things that
happen to be measurable.

Two things not to do:

- **Do not add a signal for a metric nothing writes.** `code_coverage_percent`
  and `e2e_pass_rate` are on the QA Grafana dashboard, but the only thing that
  ever writes them is `scripts/seed-qa-metrics.sh`. They are excluded on purpose.
- **Do not point a collector at the Backstage UI layer.** Every page in
  `extensions.tsx` substitutes demo data when its source is down; a collector
  reading it would score fiction as fact. Go to Prometheus, OpenCost, Langfuse or
  the catalog directly.

Weights can be overridden per environment without code:

```yaml
engineeringIntelligence:
  weights:
    finops: 2
```

Unknown keys and non-positive values are ignored rather than throwing, so a typo
degrades to the default weighting instead of taking the backend down at startup.

---

## Related

- [Architecture](architecture.md) · [Maturity model](maturity-model.md) ·
  [Roadmap](roadmap.md)
- [ADR-0006](../design/adr-0006-engineering-intelligence.md)
