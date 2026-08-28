# Engineering Maturity Model

Five levels, from manual to autonomous. A level is a description of how an
organisation works, not a score threshold — the scoring engine places an
organisation on it, but the level is the thing being described.

> **Status: defined, not yet computed.** This page is the specification. Phase 2
> wires it to the scoring engine so `/api/engineering-intelligence/maturity`
> returns a current level, a target level, the gap and the actions to close it.
> Until then the levels are a reference for reading the Engineering Health score,
> not an output of it.

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

## How a level will be determined (phase 2)

Deliberately **not** "overall score ÷ 20". A single average hides the shape that
matters: an organisation with excellent Reliability and no platform at all is not
Level 3, and averaging would say it was.

The intended rule:

1. Each level declares the dimensions it depends on and the score each must reach.
2. An organisation is at the **highest level whose every requirement it meets** —
   levels are floors, not averages, so one weak dimension holds the level down.
3. A dimension reporting `insufficient-evidence` **cannot satisfy a requirement**.
   It does not fail it either; the level is reported as *unconfirmed above N*,
   with the missing evidence named. Guessing a level from data you do not have is
   exactly the failure mode this system is built to avoid.
4. The gap is the shortest set of actions that would satisfy the next level's
   unmet requirements, drawn from the same recommendation rules the health report
   already uses.

Under that rule, and given Developer Experience currently has no data source, most
installations will report *unconfirmed above Level 3* until phase 5 lands. That
is the correct answer, and it is a more useful one than a confident wrong number.

---

## Related

- [Scoring](scoring.md) — how dimension scores are produced
- [Architecture](architecture.md) — which dimensions have real data
- [Roadmap](roadmap.md) — phase 2 is where this becomes an API
