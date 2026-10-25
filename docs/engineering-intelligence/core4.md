# DX Core 4

The platform reports engineering productivity using
[DX Core 4](https://getdx.com/research/measuring-developer-productivity-with-the-dx-core-4/),
which has four areas: **Speed, Effectiveness, Quality, Impact**. It takes the same collection
Engineering Intelligence already scores and adds the one thing that collection was missing:
**what engineers report themselves**.

| Where | What |
|---|---|
| `/core4` in Backstage | The leadership view: four areas, the key metric for each, quarter-over-quarter movement, and a breakdown by team |
| `/devex-survey` in Backstage | The quarterly DevEx survey, about 5 minutes |
| `GET /api/engineering-intelligence/core4` | The same data as JSON (user or service credentials) |
| `get_core4_report` (idp-mcp-server) | Lets the AI Assistant answer "how did Effectiveness move this quarter?" |

## Rules

1. **Team level only.** No page, endpoint or tool returns a figure for one person.
2. **No targets or rewards tied to diffs per engineer.** Core 4 only treats throughput as safe
   when it is counterbalanced by developer experience and kept out of goals and rewards. On the
   page, the Speed card always shows the experience index beside it.
3. **Groups under 5 are withheld** (`MIN_RESPONSES`). This applies to survey results and to
   per-engineer throughput. The page shows "withheld", never a blank that could be read as zero.
4. **No overall Core 4 score.** The four areas are meant to be read together, and a single
   roll-up would invite exactly the single-number reading Core 4 warns against.

## What is measured

| Area | Key metric | Secondary | Source |
|---|---|---|---|
| **Speed** | Merged PRs per engineer per week | Lead time, deploy frequency, perceived rate of delivery | DORA exporter `devex_prs_merged_weekly` ÷ catalog Group members; survey |
| **Effectiveness** | Developer Experience Index (platform) | Ease of delivery | Survey |
| **Quality** | Change failure rate | Failed deployment recovery time (MTTR), perceived quality, scanning controls | DORA exporter; survey; Tech Insights |
| **Impact** | % of time on new capabilities | — | Survey |

**Not measured, and stated on the page:** time to 10th PR (the catalog has no start dates),
regrettable attrition (HR data), initiative ROI, revenue per engineer, and R&D as % of revenue
(finance data). Bring these to the leadership review from their owners.

The DORA and security signals are *reused* from the health model in `dimensions.ts` rather than
redeclared, so a band change there also changes Core 4.

### The experience index is ours

DX's DXI is a proprietary instrument. Ours is a 14-driver index in the same spirit
(`DRIVERS` in `packages/engineering-intelligence-core/src/devexSurvey.ts`): deep work, local
iteration, CI, code review, release process, change confidence, maintainability, docs,
self-service, incident response, requirements, collaboration, tech debt and planning stability.
Each driver is answered 1–5 and mapped to 0–100, and the index is the mean of the 14 drivers.
**Do not compare it with DX's published benchmarks.**

### Throughput caveats

- The exporter counts merges over a fixed trailing 7 days, using the single bounded page of
  100 PRs it already fetches. A repo merging more than 100 PRs a week is undercounted.
- A service counts toward a team only if its catalog `spec.owner` is a Group with members.
  A person in two teams counts once in the organisation figure.
- Until the exporter has run with the new series, Speed is scored from DORA data and the survey alone.

## Privacy

- Responses are stored with a **per-cycle HMAC** of the user ref, not the ref itself. It is keyed
  with a per-install salt kept in the plugin's own database. Its only use is refusing a second
  response in the same cycle, and responses can't be joined across cycles.
- A respondent can only file their response under a Group they belong to (resolved server-side
  through `userInfo`). Anyone without a Group goes under `unassigned`.
- `/aggregate` serves means only. Below the floor it serves the response count and nothing else.
- **No averages while a cycle is open.** A live mean changes with every submission, so reading it
  just before and just after a colleague answers would reveal their answers. While a cycle is open,
  only counts are served. Averages, and Effectiveness and Impact on `/core4`, update when it closes.

## Running it

1. **Baseline (weeks 1–3).** Someone in `group:default/platform-team` opens a cycle at
   `/devex-survey`, for example *"Q4 2026"* for 14 days. Announce it through the Announcements
   page. Results appear when the cycle closes, for each team where at least 5 people answered.
2. **Quarterly.** Open one cycle a quarter. `/core4` compares against the first snapshot from
   90 days earlier, and shows no movement until a snapshot at least 7 days old exists.
3. **Act.** Each quarter, pick the one or two lowest drivers as platform-team initiatives
   (the Learning Center, a golden path, a CI fix), then check whether they moved next quarter.
4. **Review.** Use the `/core4` page directly. The executive report (`/report/executive`) also
   carries a Core 4 block for the quarterly readout.

## Implementation

| Piece | File |
|---|---|
| Survey question set, validation, aggregation | `packages/engineering-intelligence-core/src/devexSurvey.ts` |
| Core 4 areas, team rows, movement | `packages/engineering-intelligence-core/src/core4.ts` |
| Survey plugin (`backstage_plugin_devex-survey` DB) | `packages/backend/src/modules/idpDevexSurvey.ts` |
| Collectors | `engineeringIntelligence/throughput.ts`, `engineeringIntelligence/devexSurvey.ts` |
| Pages | `packages/app/src/engineeringIntelligence/Core4Page.tsx`, `packages/app/src/devexSurvey/` |
| Exporter series | `devex_prs_merged_weekly` in both `{local,aws}/observability/dora/dora-exporter.py` |

Core 4 is attached to each persisted snapshot as `report.core4`, the same way maturity is,
because nothing else keeps last quarter's figure. Either source can be switched off with
`engineeringIntelligence.sources.devexSurvey` or `.throughput`.
