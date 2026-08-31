# Engineering Maturity Model

Five levels, from manual to autonomous. A level is a description of how an
organisation works, not a score threshold — the scoring engine places an
organisation on it, but the level is the thing being described.

> **Status: computed.** `GET /api/engineering-intelligence/maturity` returns the
> current level, whether it is confirmed, the target level, the gap and the
> actions that would close it. The assessment also rides on every `HealthReport`,
> so each persisted snapshot records the level — the level is what leadership
> tracks over time, and it cannot be recomputed later from a report that did not
> store it. Implementation: `packages/engineering-intelligence-core/src/maturity.ts`.

---

## Level 1 — Ad Hoc

Manual processes and inconsistent practice. Deployment is a person, not a
pipeline. Two services solve the same problem two ways. Nobody can say who owns
what without asking.

**Signals:** ownership coverage low, no golden-path adoption, deploy frequency
below weekly, no scorecard tier above none.

## Level 2 — Standardised

CI/CD exists and is used. Infrastructure is code. There is an observability
stack, and engineering standards are written down somewhere people actually read.
Practice is consistent even where it is not automated.

**Signals:** scorecard checks passing above ~50%, static analysis and vulnerability
scanning declared in CI, deploy frequency at least weekly, change failure rate
measured at all.

## Level 3 — Platform Enabled

An Internal Developer Platform exists and developers self-serve through it.
Golden paths are the default rather than the exception. Scorecards, DORA metrics
and SLOs are in place and looked at.

**Signals:** golden-path adoption above ~70%, most services at Bronze or better,
DORA metrics in the High or Elite bands, SLOs defined beyond a single reference
service.

*This is roughly where a well-run installation of this platform sits.*

## Level 4 — AI Enabled

AI is part of how engineering works, and is governed like anything else in
production: evaluated, observed, cost-attributed, and covered by policy. AI
services carry model cards and evaluation suites the same way other services
carry tests.

**Signals:** AI governance checks passing, LLM traces flowing to an observability
backend, evaluation suites running in CI, AI cost attributable to a team.

*The platform ships the machinery for this — KAgent, Langfuse, DeepEval, MLflow,
the AI-governance scorecard checks — so Level 4 is reachable here. Cost
attribution is the missing piece; see phase 8.*

## Level 5 — Autonomous Engineering

Agents do bounded work end to end, under human-approved policy. Remediation is
automated for known failure classes. Testing is selected intelligently rather
than run exhaustively. Insight is predictive rather than retrospective.

**Signals:** approval-gated agent actions in production, automated remediation
with a measured success rate, test-impact analysis in use, forecasts acted on.

*The Agentic Development Platform (`scripts/bootstrap-ai.sh --adp`) and the
human-in-the-loop approval gate are the first pieces of this. It is the least
proven level, and claiming it without the approval gate genuinely enforced would
be the most expensive mistake in this document.*

---

## How a level is determined

Deliberately **not** "overall score ÷ 20". A single average hides the shape that
matters: an organisation with excellent Reliability and no platform at all is not
Level 3, and averaging would say it was.

The rule:

1. Each level declares the dimensions it depends on and the score each must reach.
2. An organisation is at the **highest level whose every requirement it meets** —
   levels are floors, not averages, so one weak dimension holds the level down.
   The walk *stops* at the first level that is not fully met, so a strong Level 4
   score cannot carry an organisation past an unmet Level 2 floor.
3. A dimension reporting `insufficient-evidence` **cannot satisfy a requirement**.
   It does not fail it either; the level is reported as *unconfirmed above N*,
   with the missing metrics named. Guessing a level from data you do not have is
   exactly the failure mode this system is built to avoid.
4. **A definite failure outranks missing evidence.** A level with one genuinely
   unmet requirement is `unmet`, even if another could not be measured — knowing
   you fall short is knowing something, and a real shortfall must not hide behind
   a data gap.
5. The gap is the target level's unmet requirements, plus the subset of the
   health report's existing recommendations that bear on those dimensions.

### The requirements

| Level | Requirement | Floor |
|---|---|---|
| **2 — Standardised** | Quality | 50 |
| | Platform | 40 |
| | Reliability | 40 |
| **3 — Platform Enabled** | Platform | 70 |
| | Quality | 65 |
| | Reliability | 65 |
| **4 — AI Enabled** | AI Engineering | 65 |
| | Security | 60 |
| | Developer Experience | 60 |
| **5 — Autonomous** | AI Engineering | 80 |
| | Reliability | 80 |
| | *Approval-gated agent actions, enforced and measured* | not measurable |
| | *Automated remediation with a measured success rate* | not measurable |

Level 1 has no requirements. It is the floor — a Level 1 assessment is the
absence of evidence for Level 2, not a finding in its own right.

Every requirement carries a `because` string explaining why that dimension gates
that level. A threshold with no stated reason is a number nobody can defend, and
`maturity.test.ts` asserts none is left blank.

### Two levels you cannot reach today, and why

**Level 4** requires a Developer Experience score, and nothing in the platform
produces one. Most installations therefore report *unconfirmed above Level 3*
until phase 5 lands. That is the correct answer, and a more useful one than a
confident wrong number.

DevEx gates Level 4 rather than Level 3 on purpose: Level 3 asks whether a
platform exists and is adopted, which the Platform, Quality and Reliability
dimensions answer. Level 4 asks whether it is measurably *working* before AI is
layered on top — and that claim cannot be made without DevEx data.

**Level 5** declares two `capability` requirements that no collector supplies, so
it is structurally unconfirmable rather than merely unmet. Nothing measures
whether the human-in-the-loop approval gate is actually enforced or whether agent
remediation resolves the incidents it was raised for. Awarding "Autonomous
Engineering" for a high AI score would make exactly the claim there is no
evidence for — and this platform has had that approval gate found silently
disabled before.

---

## Related

- [Scoring](scoring.md) — how dimension scores are produced
- [Architecture](architecture.md) — which dimensions have real data
- [Roadmap](roadmap.md) — the phases, and the data blocker on each
