# AI Advisor

The advisor answers questions about the platform's engineering health in plain language.
Its design constraint is the one that makes such a feature trustworthy or useless:

> **It may only say things the collected metrics support, and it must say so when they
> do not.**

A fluent paragraph that sounds like an answer is worse than no answer, because it is acted
on. "Team A is understaffed" is the canonical failure — plausible, confident, and backed by
nothing this platform measures.

## What it is today: arithmetic, not generation

The shipped advisor is **deterministic**. Every answer is a lookup or a subtraction over the
scored report. `answer()` in `advisor.ts` handles six questions:

| Question | How it is answered |
|---|---|
| `biggest-risks` | Ranks the report's own risks by severity |
| `why-changed` | Compares the two most recent snapshots and names the dimensions that moved |
| `focus-next` | Reads the blockers on the next maturity level |
| `teams-needing-attention` | **Refuses.** Engineering Health is platform-wide; nothing here is per-team |
| `ai-readiness` | Reports the AI readiness score, or what is missing when it cannot be scored |
| `reduce-cost` | Reports spend and attribution — with no saving figure |

Two of those six are refusals by design.

Generation is deliberately not wired up. A model asked "why did the score drop?" could only
agree with the subtraction or contradict it, and only the second is a change in behaviour.
What the architecture provides instead is the safe input for one — the context builder and
the citation guardrail below — so wiring a model in later is a small, reviewable change
rather than a redesign.

## The context boundary

`buildAdvisorContext()` produces everything a model would be allowed to see. It is a
**reduction**, and what it removes matters more than what it keeps:

- **Evidence `labels` are stripped.** They carry user ids (`user:default/alice`), raw trace
  names and cost strings. Every evidence row reaching the context has exactly three keys:
  `metric`, `source`, `value`.
- **`unmatchedNames` is dropped.** It is uncontrolled text written by whatever emitted a
  trace — precisely the input that should never reach a prompt.
- **AI spend is reduced to team totals.** `byWorkload` is removed entirely.

What remains is scores, coverage, missing-signal names, maturity blockers and team-level
spend totals. None of it identifies a person, and none of it is free text from an external
system.

The `advisor.test.ts` suite asserts this by serialising the context and searching it, rather
than by trusting the type — so a field added without updating the doc comment still fails.

## The citation guardrail

Every answer carries `citedMetrics`, and `unsupportedCitations()` checks each id against the
vocabulary the context actually contains:

```ts
unsupportedCitations(['devex.moraleIndex'], context)  // → ['devex.moraleIndex']
```

The vocabulary includes both **collected** and **missing** signals, because "we could not
measure `devex.prCycleTimeHours`" is a legitimate claim about the data. Anything outside it
is an invention.

This is the check a generated answer would be run through before display. A model that cited
a metric this platform does not collect would have the answer rejected, not shown with a
caveat.

## The refusals

Three, all of them load-bearing:

**Ranking teams.** Every metric here is platform-wide. A per-team ranking would be
fabricated, so the question returns `insufficientEvidence` and says why. Asked with AI spend
available, it answers the spend question only, labelled *"a spend figure, not a performance
one"* — because cost is not performance and the distinction disappears the moment a number
is shown without it.

**Explaining a trend that does not exist.** Prometheus retention is 6h locally and 30d on
AWS, and the snapshot store starts empty. With fewer than two scored snapshots the advisor
says the history *"cannot be back-filled"* rather than describing a movement it cannot see.

**Quantifying a saving.** Nothing measures workload complexity, so "move this to a cheaper
model and save $N" would be invented. The answer reports actual spend and states that no
saving figure is offered.

A dimension unscored at either end of a comparison is skipped rather than reported as a
change — "we could not measure it last week" is not a decline, and reporting it as one sends
a team chasing something that never happened.

## Wiring in a model

The extension point is `answer()`. A generated answer must:

1. Take `buildAdvisorContext()` output as its **only** source of platform data.
2. Return `citedMetrics`, and be rejected if `unsupportedCitations()` is non-empty.
3. Set `insufficientEvidence` rather than producing prose when the context cannot support
   an answer.
4. Preserve the refusals above — they are properties of the data, not of the implementation,
   and a model does not make per-team data exist.

The deterministic path should remain the fallback for every question, so a model being
unavailable degrades the answer's fluency and never its correctness.

## See also

- [Scoring](scoring.md) — how a score decomposes into evidence
- [Integrations](integrations.md) — where the underlying metrics come from
- [ADR-0006](../design/adr-0006-engineering-intelligence.md)
