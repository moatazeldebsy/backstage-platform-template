# Shift-Left Quality — Leadership Guide

This page is for engineering leaders: VPs, Directors, and Heads of Engineering who are sponsoring or evaluating the shift-left quality programme. It covers the business case, the adoption plan, what you need to invest, and how to measure success.

For the practitioner guide (what engineers do day-to-day), see [Shift-Left Quality Engineering](shift-left.md).
For the pilot kickoff agenda, see [Shift-Left Pilot Kickoff](shift-left-pilot-kickoff.md).

---

## The business case in one paragraph

Defects caught in production cost 10–100× what they cost if caught at the pull-request stage, and 1,000× what they cost if caught in a developer's editor. Every escaped defect is a compounded cost: engineer time to reproduce, incident response, customer impact, and reputation. The shift-left programme moves detection upstream — into CI, the PR gate, and the deploy hook — without slowing delivery. The platform provides the automation; your teams provide the services. The result is faster release cycles, fewer incidents, and a measurable quality baseline you can report on.

---

## What "shift-left" means on this platform

Shift-left is not a new test suite. It is a set of **automated gates** embedded in the developer workflow so that quality checks run closer to the source of the defect. On this platform, four loops enforce those gates:

| Loop | When it runs | What it catches |
|---|---|---|
| **Local** | Immediately, in the developer's terminal | Syntax, formatting, secrets committed by accident |
| **PR** | Within 2–5 minutes of every commit | Coverage gaps, vulnerable dependencies, container failures, API breaking changes |
| **Deploy** | At ArgoCD sync time | Policy violations, breaking API contract changes |
| **Runtime** | Every 15 minutes | Scorecard regressions, flaky tests, drift from quality baseline |

Every gate is provided by the Internal Developer Platform and wired automatically into each new service at scaffold time. Teams do not configure these gates — they inherit them.

---

## The maturity model

Every service in the platform catalog is scored against 11 checks and assigned a tier:

| Tier | Threshold | What it means |
|---|---|---|
| 🥉 Bronze | 4 / 11 | Baseline hygiene: the service has an owner, docs, health probes, a runbook, an API definition, and a pinned image tag |
| 🥈 Silver | 7 / 11 | Bronze + shift-left CI: coverage gate, static analysis, vulnerability scanning — all blocking at PR time |
| 🥇 Gold | 10 / 11 | Silver + contract testing (API breaking-change gate) + end-to-end tests |

A service scaffolded from the platform today reaches **Silver automatically** — the hardened CI template is the default. Moving from Silver to Gold requires two deliberate steps (contract suite + E2E suite) and takes approximately two days of engineering time.

The tier is visible to everyone — in Backstage's Tech Insights tab on each service entity, and in a Grafana dashboard filterable by team and tier. Leadership can see the distribution across the organisation at a glance.

---

## Adoption plan

The programme rolls out in three phases. Each phase builds on the last and is designed to be low-risk: no team is blocked from shipping while adopting.

### Phase 1 — Pilot (Weeks 1–4)

**Goal:** Prove the path works on two real services with two willing teams.

- The platform team pairs with two volunteer service teams through a [structured 4-week pilot](shift-left-pilot-kickoff.md).
- Each pilot team lands one service at Gold tier.
- The platform team captures time-to-tier, blockers, and team feedback.
- Output: a retro doc, a prioritised improvement list, and two named champion teams who can brief peers.

**Leadership asks:**
- Nominate two teams (pick teams that ship frequently — the feedback loop compounds faster).
- Protect ~1 day/week of tech lead time for 4 weeks. Engineers and tech leads run the work; the platform team is alongside.
- Attend the week-4 retro readout (30 minutes).

**Success bar:** Both services at Gold within 21 days. CI duration increase ≤30%. At least one breaking-change deploy blocked by the contract gate (demonstrating the gate works).

---

### Phase 2 — Expand (Months 2–3)

**Goal:** Roll out Silver-tier adoption to all services that have been active in the last 90 days.

- Each team is given a self-service path: one Backstage template click to upgrade CI, one sprint to clear the coverage baseline.
- The platform team runs bi-weekly office hours (30 min) rather than pairing per team.
- A Grafana dashboard tracks tier adoption rate across the organisation — leadership can see it without asking.
- Teams that hit a specific blocker (e.g. a legacy service with untestable code) get a documented exception process, not a deadline that forces a shortcut.

**Leadership asks:**
- Set an organisation-level target: "All active services at Silver by end of Month 3."
- Announce the target and the tool — a short Slack message from leadership with a link to the self-service path is enough.
- Review the adoption dashboard monthly. Identify teams that are stuck and unblock them (usually: protected time from other work, not a platform problem).

**Success bar:** ≥80% of active services at Silver. Adoption rate increasing week-on-week. No team has been blocked from shipping by a gate.

---

### Phase 3 — Scale to Gold (Months 4–6)

**Goal:** Drive Gold-tier adoption for services that are user-facing or on the critical path.

- Prioritise: customer-facing services, services with the highest change failure rate, services that have been the source of the most incidents in the past 6 months.
- Gold requires contract testing and E2E tests. For legacy services without an OpenAPI spec, the platform provides a migration guide.
- The maturity model and scorecard become part of the engineering planning cycle — Gold tier is an input to "is this service ready for more traffic / a new team dependency?"

**Leadership asks:**
- Define which services are the first Gold targets (this is a product/engineering judgement, not a platform decision).
- Incorporate tier into quarterly planning — "we're taking this service from Silver to Gold this quarter" is a valid engineering goal.
- Consider making Gold a prerequisite for services handling PII or serving >1k RPS. This is a policy decision for leadership, not the platform team.

**Success bar:** All user-facing and critical-path services at Gold. Change failure rate trending down in DORA dashboard. Flaky-test count per service ≤2.

---

## What you are investing

| Resource | Phase 1 | Phase 2 | Phase 3 |
|---|---|---|---|
| Engineering time (pilot teams) | ~1 day/week × 2 teams × 4 weeks | 1–2 days per team (self-service) | 1–2 days per service for Gold steps |
| Platform team time | ~3 hrs/week facilitation | ~1 hr/week office hours | As needed for blockers |
| Leadership time | Kickoff nomination + week-4 readout | Monthly dashboard review | Quarterly planning input |
| Tooling cost | $0 — all gates are open source, already in the platform | Same | Same |

The main investment is engineering time for the pilot teams. No new tooling budget is required — the platform already provides every gate described in this programme.

---

## How to read the dashboards

Three dashboards give leadership visibility without requiring Kubernetes access.

### Scorecard dashboard (Grafana)

`http://grafana.idp.local/d/scorecard` (local) or the ALB URL after AWS deployment.

- **Tier distribution panel** — pie chart of Bronze / Silver / Gold across all services. This is the headline adoption metric.
- **Per-team panel** — filter by `team` label to see any team's distribution.
- **Per-check heatmap** — which specific checks are failing organisation-wide. If `has-coverage-gate` is red for 40% of services, that is the next highest-leverage gate to drive.

### DORA dashboard (Grafana)

`http://grafana.idp.local/d/dora/dora-metrics`

Four metrics tied directly to the shift-left programme:
- **Deployment frequency** — increases as teams gain confidence to ship. Should trend up after Silver adoption.
- **Lead time for changes** — time from commit to production. The PR gates add minutes; they remove hours of manual review and incident investigation. Should trend down.
- **Change failure rate** — percentage of deployments that cause an incident. Should trend down as contract and E2E gates catch regressions before deploy.
- **Mean time to recovery** — time to restore service after an incident. Runbook adoption (Bronze check) and the alerting stack drive this down.

### AI Assistant (Backstage)

`http://backstage.idp.local/ai-assistant`

The IDP assistant can answer questions like "which services on team X are below Silver?" or "what is the current Gold adoption rate?" in plain language, using live data from the platform.

---

## Governance and decision rights

| Decision | Who decides |
|---|---|
| Which gates are mandatory (OPA, PreSync hook) | Platform team — these are cluster-wide and not opt-out |
| Coverage threshold (default 70%) | Platform team owns the default; service teams can raise it for their own service |
| Which services are first Gold targets | Engineering leadership |
| Exception to a gate for a specific service | Platform team approves, with a time-boxed remediation plan |
| Tier targets per team | Engineering leadership + team leads, set quarterly |
| Tool changes inside a gate (e.g. swap `ruff` for `pylint`) | Platform team — standardisation is load-bearing for scorecard accuracy |

---

## Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Legacy services can't hit Silver (no tests, no coverage) | Medium | Bronze is the floor; Silver adoption is incentivised not mandated in Phase 2. Exception process exists. |
| Gates slow down CI and teams resist | Low | Gates add 2–5 min to PR builds. The platform team monitors CI duration weekly in Phase 1 and will tune if needed. |
| Pilot teams deprioritise due to feature pressure | Medium | Leadership commitment to protect ~1 day/week is the primary mitigation. Pilot kickoff is explicit about this. |
| Scorecard data lags reality | Low | Scorecard refreshes every 15 min. Exception: a new service takes up to 30 min to appear after catalog registration. |
| Contract testing breaks existing CI for legacy services | Low | `enable-contract-testing` only runs on services that opt in. Existing CI is unchanged until the template is applied. |

---

## FAQ for leaders

**Do we need to rewrite our existing tests?**
No. The gates wrap existing tests with coverage enforcement and scanning. The only new tests required are contract tests (Day 2) and E2E tests (Day 3 / Gold), and those are scaffolded automatically.

**What happens to services that never reach Gold?**
Nothing immediately. Bronze and Silver have real value. Gold is the target for services that are user-facing or load-bearing for other teams. Services in an internal tooling role may be fine at Silver indefinitely.

**Can teams skip gates for an urgent release?**
Local gates (pre-commit) can be bypassed per-commit (`--no-verify`). PR gates require an explicit CI override (PR admin can skip with justification). Deploy-time OPA and contract gates are not bypassable without a platform team change. This is intentional — the deploy gates exist specifically to prevent "skip it just this once" becoming a habit.

**How does this relate to our compliance or audit requirements?**
The scorecard provides documented evidence of: test coverage ≥70%, vulnerability scanning on every PR, image signing (Cosign), and API contract validation. These artefacts can be exported from Grafana or queried from CloudWatch (AWS). If your compliance requirement has a specific format, the platform team can add an exporter.

**Who do I call when a gate is wrong and a team is stuck?**
The platform team owns the gates. File an issue in `backstage-platform-template` tagged `priority/high`. SLA: platform team responds within 1 working day, proposes a fix or exception within 3.

---

## Quick-start checklist for leadership

- [ ] Read this page (done).
- [ ] Nominate two pilot teams — pick the ones that ship most often.
- [ ] Confirm with those teams' managers that ~1 day/week is available for 4 weeks.
- [ ] Book 30 minutes for the week-4 pilot retro readout.
- [ ] Set a Phase 2 target: "All active services at Silver by [date]."
- [ ] Review the scorecard dashboard once after Phase 1 completes.

That's it for Phase 1. The platform team handles the rest.
