# Integrations

Every number on the Engineering Intelligence dashboard comes from a system that already
existed in this platform. Nothing is generated, and nothing is defaulted — this page is the
map from a score back to the process that produced it.

The layering is one-directional:

```
source system → collector → MetricSample[] → scoring engine → API → UI
```

A collector's only job is to turn one source into `MetricSample` rows. It applies no
policy, computes no score, and substitutes no value.

## The collectors

Collectors live in `backstage/app/packages/backend/src/modules/engineeringIntelligence/`.

| Collector | Source system | Metrics it produces |
|---|---|---|
| `prometheus.ts` | Prometheus `/api/v1/query` | `dora.deployFrequencyPerDay`, `dora.leadTimeMinutes`, `dora.changeFailureRatePercent`, `dora.mttrMinutes`, `devex.prCycleTimeHours`, `devex.ciDurationMinutes`, `devex.buildFailureRatio`, `test.passRate`, `test.flakinessRatio`, `scorecard.goldTierRatio`, `finops.budgetUtilisationRatio`, `ai.mcpToolSuccessRatio` |
| `catalog.ts` | Backstage catalog API | `catalog.ownershipCoverage`, `catalog.goldenPathAdoption` |
| `techInsights.ts` | Tech Insights facts API | `scorecard.checksPassedRatio`, `security.scanningControlsRatio`, `ai.modelCardRatio`, `ai.evalSuiteRatio`, `ai.observabilityWiredRatio`, `ai.governanceChecksRatio` |
| `opencost.ts` | OpenCost `/allocation/compute` | `finops.costEfficiencyRatio` |
| `langfuse.ts` | Langfuse v3 metrics + traces API | `ai.observabilityActive`, `ai.promptsManagedRatio` |
| `langfuseScores.ts` | Langfuse `/api/public/v2/scores` | `ai.evalPassRatio` |
| `aiCost.ts` | Langfuse metrics + traces API | `ai.costAttributedRatio` |
| `scaffolder.ts` | Backstage scaffolder API | `scaffolder.taskSuccessRatio` |
| `mlflow.ts` | MLflow registry | `ai.modelVersionedRatio` |

`techInsights.ts` **consumes** facts and recomputes no check. That is deliberate: tier logic
already exists in three places in this repo and has drifted between them
(see [ADR-0006](../design/adr-0006-engineering-intelligence.md)). A fourth copy would drift too.

Collectors read their source **directly**, resolving the address from the existing
`proxy.endpoints.*.target` config. They must never read the Backstage UI layer, because
`extensions.tsx` substitutes demo fiction when a source is down — exactly the failure this
subsystem exists to avoid.

## When a source is unavailable

`getJson()` in `source.ts` treats a 500, a timeout (`SOURCE_TIMEOUT_MS`, 10s), a connection
refusal and a malformed body identically: **all of them yield no sample.** `collect.ts` runs
collectors concurrently and catches per collector, so one dead source cannot fail a
collection or delay it past its own timeout.

The consequence is the property the whole design rests on:

> An unreachable source lowers **coverage**, never the **score**.

A dimension whose coverage falls below its `minCoverage` returns `score: null` and
`status: 'insufficient-evidence'`, and is excluded from the weighted total rather than
counted as zero. Stopping Prometheus makes dimensions go grey; it never makes them go bad.

### Absence is not zero — including upstream

The harder version of the same rule is that a source can publish a number it should have
omitted. Two real instances were found on a live cluster and are now guarded in
`prometheus.ts`:

- **Never-deployed repos.** The DORA exporter publishes `0.0` change-failure rate for a repo
  that has never deployed. Banded normalisers read 0% CFR as elite, so "no deployments ever"
  scored as perfect reliability. Change failure rate, MTTR and lead time are now withheld
  when the deploy total for a service is zero.
- **Unattributed spend.** Budget utilisation of `0` read as perfect cost discipline when it
  actually meant no cost had been attributed. Budget utilisation is now withheld unless
  `idp_team_actual_cost_usd_monthly > 0`.

Unit tests cannot catch this class of bug — the collector parses the number correctly and
the scorer scores it correctly. Only comparing an output against the real world finds it.

## Configuration

All optional; every source defaults to on. Typed in `packages/backend/config.d.ts`.

```yaml
engineeringIntelligence:
  refreshMinutes: 30            # matches the Tech Insights fact-retriever cadence
  sources:
    prometheus: true
    opencost: true
    langfuse: true
    catalog: true
    techInsights: true
    scaffolder: true
```

A source that is enabled but unreachable simply produces no samples, so a kill switch is an
optimisation — skipping a call known to fail — rather than a requirement.

Langfuse credentials prefer an explicit `langfuse.publicKey` / `langfuse.secretKey` pair and
otherwise fall back to the `Authorization` header already configured on the `/langfuse`
proxy, so a working Langfuse proxy needs no second copy of the credential. The placeholder
value Backstage requires when `LANGFUSE_BASIC_AUTH` is unset is detected and treated as
unconfigured.

## Adding a collector

1. Write `myThing.ts` exporting a function returning `Promise<MetricSample[]>`. Give every
   sample a `metric`, `value`, `source` and `observedAt` — the evidence contract requires all
   four, and a sample missing any of them cannot be rendered as evidence.
2. Resolve the address through `proxyTarget()` rather than hard-coding a host. Note that
   `proxy.endpoints` is read as a raw object, because a slash is not a legal character in a
   Backstage config key path.
3. Fetch through `getJson()` so failure degrades to absence for free.
4. Register it in `collect.ts` and add its kill switch to `config.d.ts`.
5. Verify it against a **real instance**, not only a fixture — see
   `engineeringIntelligence.live.test.ts`. A fixture written by the collector's
   author agrees with whatever that author assumed, so it cannot catch a wrong
   endpoint, a wrong HTTP method, or a field that does not exist. Every such bug
   found in this subsystem was found by running against something real.
6. Declare the signal in `dimensions.ts` with a weight and a normaliser. **Until a metric
   appears there it changes no score** — collecting it and scoring on it are separate steps,
   which is what makes a new source safe to add.
7. Test the parser against a **recorded** fixture, and assert that a 500 produces no
   samples rather than a throw or a substituted value.

## Current data availability

Honest status on a running local platform:

| Metric group | Status |
|---|---|
| DORA, DevEx, catalog, Tech Insights, OpenCost, scaffolder | Live |
| `test.passRate`, `test.flakinessRatio` | **Live.** The platform's own CI publishes JUnit XML as `test-results-*`. The exporter looks back over `WINDOW_SIZE` completed runs — every workflow, not just CI — so a repo with frequent CodeQL or docs-deploy runs needs a deeper window than the number of CI runs suggests; `MAX_ARTIFACT_RUNS` caps what that costs |
| MLflow | **Live-verified** against MLflow 2.13.0. Running it found the collector POSTing to `registered-models/search`, which answers `Allow: HEAD, OPTIONS, GET`; the recorded response is committed as a fixture |
| Langfuse observability, scores, AI cost | **Live-verified** against a self-hosted Langfuse v3. Running them found `limit=500` on `/traces` and `/v2/scores` returning HTTP 400 — the cap is 100 — which `getJson` turned into "no data", so both collectors reported the source as unavailable. Now paged. Score joining (`NUMERIC` + `_pass` `BOOLEAN`) and workload→team cost attribution were both confirmed against real ingested data |
| Langfuse per-model cost breakdown | **Still spec-verified only.** The `providedModelName` dimension could not be exercised: a fresh Langfuse returns `count_count: 0` from the metrics API for every view — traces, scores and observations alike — while the list endpoints return the same data fine. The query shape is accepted and the envelope matches; only the aggregation had nothing in it |

DevEx and DORA metrics cover repositories carrying the `idp-app` topic; a repository without
it is invisible to the exporter.

Test metrics come from the flaky-test exporter, which reads every catalog `Component`
carrying a `github.com/project-slug` annotation and downloads each recent run's
`test-results*` artifact. Artifact names are matched on **prefix**, because
`upload-artifact@v4` rejects two artifacts sharing a name within one run — a repository with
a Go job and a Python job has to publish `test-results-go` and `test-results-python`, and
both must be read or one language's failures are invisible. Several catalog components may
share a repository, in which case each is credited with that repository's test results.

Two metrics are deliberately **not** collected: `code_coverage_percent` and `e2e_pass_rate`
were only ever written by `scripts/seed-qa-metrics.sh`, which fabricated them at source and has since been removed.
