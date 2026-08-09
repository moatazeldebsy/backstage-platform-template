# Shift-Left Pilot — Kickoff Agenda & Team Brief

This page is the operating document for the 4-week shift-left pilot with two service teams. It contains:

1. The **one-page brief** to send to each team before the kickoff.
2. The **kickoff session agenda** (2 hours, single meeting).
3. The **4-week cadence** the platform team will run.

If you're a pilot team member, read sections 1 and 2 only. If you're running the programme, all three.

---

## 1. One-page team brief (send 3 days before kickoff)

**Subject:** You've been picked for the Shift-Left Quality pilot — 4 weeks, ~1 day of your time per week

**What's happening:** Over the next 4 weeks, your team adopts the platform's shift-left quality gates end-to-end on one of your services. The goal is to land that service at **Gold** tier on the IDP scorecard and to give us evidence the path works for real teams. The platform team is in the room with you the whole time — you are not a guinea pig, you're a co-author.

**Why your team:** [Fill per team — example: "You ship more changes per week than the average team, so faster feedback compounds for you" or "Your service is the next one going to public traffic, so the security/contract gates are load-bearing."]

**What you'll commit:**
- **2 hours** for the kickoff session (see agenda below).
- **~4 hours/week** for 4 weeks — actual implementation work (mostly your tech lead + one engineer).
- **15 minutes/week** for the platform team's review call (Fridays, optional but recommended).

**What you get out of it:**
- A service with full PR-time lint, coverage, vuln, and contract gates — no more "we'll catch it in staging."
- A visible scorecard tier and DORA metrics for your team in Grafana.
- Direct line to the platform team for anything blocking.
- First-mover input on the next round of platform gates (flaky-test detection, pre-commit bundle).

**What you'll need ready by the kickoff:**
- Pick **one service** in your portfolio to be the pilot. Pick the one you ship most often, not the most complex.
- The Backstage `catalog-info.yaml` for that service merged (so we can see the current scorecard).
- A working local dev loop (`make test` or equivalent passes).
- Two team members available for the full 2 hours of the kickoff.

**Pre-reads (15 min total):**
- [Shift-Left Quality programme overview](shift-left.md) — sections "The four feedback loops" and "The scorecard tiers" only.
- The current scorecard panel for your service in Grafana: `http://grafana.idp.local/d/scorecard` (filter by service name).

**Out of scope for the pilot:**
- Rewriting tests you already have. We're adding gates around existing tests, not replacing them.
- Touching prod traffic. All gates are PR + deploy time only; no changes to running services.
- New tooling decisions. You use what the platform provides; we capture feedback for v2.

---

## 2. Kickoff session — 2 hours, in person or video

**Attendees:**
- Team A: tech lead + 1 engineer (required), team manager (optional)
- Team B: tech lead + 1 engineer (required), team manager (optional)
- Platform team: pilot lead (facilitator), one platform engineer (driver), one QE (observer/scribe)

**Pre-flight (do before the meeting starts):**
- Both teams have their service catalog-info merged and showing in Backstage.
- Grafana scorecard panel open on the shared screen.
- A scratch GitHub PR template ready to copy.

### Minute-by-minute agenda

| Time | Topic | Format | Output |
|---|---|---|---|
| 00:00 – 00:10 | **Welcome + why these two services** | Facilitator-led, 2 slides | Shared understanding of *why your service was picked* |
| 00:10 – 00:20 | **Programme shape** — the 4 feedback loops, the tier model, what "Gold" means concretely | Live walkthrough of [shift-left.md](shift-left.md) | Teams can name the 4 loops |
| 00:20 – 00:30 | **Baseline reading** — look at each team's current scorecard live; identify which checks they already pass | Live in Grafana + Backstage Tech Insights tab | Whiteboarded list per team: what's green, what's red, what's missing annotation |
| 00:30 – 00:55 | **Day-1 walkthrough — landing at Silver** | Hands-on, screen-shared. Each team in turn: open their CI workflow, compare to the hardened skeleton, identify the diff to land Silver | A draft PR (not merged) per team that updates `.github/workflows/ci.yml` to match the hardened skeleton |
| 00:55 – 01:00 | **5-minute break** | | |
| 01:00 – 01:25 | **Day-2 walkthrough — adding the contract gate** | Live demo: run `enable-contract-testing` template against a throwaway service. Then identify what each pilot team's service needs to be ready for it (does it have an OpenAPI spec? if no, where would it live?) | Per team: list of prerequisites to run `enable-contract-testing` themselves |
| 01:25 – 01:40 | **Day-3 walkthrough — adding the E2E gate** | Demo the `playwright-e2e-suite` template; discuss what 3-5 user journeys each team would E2E first | Per team: list of 3-5 candidate E2E journeys |
| 01:40 – 01:50 | **Risks, objections, exceptions** — open floor | Discussion | Captured list of "this won't work for us because…"; platform team commits to come back with answers within 2 working days |
| 01:50 – 02:00 | **Cadence + next steps** | | Calendar invites sent: weekly Friday review, 15 min; Slack channel `#shift-left-pilot` confirmed; tech leads named as their team's pilot lead |

### Exit criteria for the kickoff

You don't end the session until each of these is true:

- [ ] Each team has a draft PR (against their service repo) updating CI to the hardened skeleton.
- [ ] Each team has named a single tech lead as their pilot lead.
- [ ] Each team knows the 3 commands they'll run this week: `git checkout -b ci-hardening`, the template name in Backstage they'll click, and how to verify the scorecard updated.
- [ ] The Friday 15-min review is on both teams' calendars for 4 weeks.
- [ ] `#shift-left-pilot` Slack channel exists with both teams and the platform team in it.

---

## 3. The 4-week cadence

After the kickoff, the platform team runs a light-touch operating rhythm. Total platform-team effort: ~3 hours/week.

### Weekly Friday review — 15 minutes

**Standing agenda:**
1. **What moved on the scorecard this week?** (Grafana panel — shared screen) — 5 min
2. **What blocked you?** — each team, 2 min each — 5 min
3. **Platform team commitments for next week** — 5 min

**Async between meetings:** Slack `#shift-left-pilot`. Platform team SLA: respond within 1 working day.

### Per-week expectations

| Week | Pilot team output | Platform team output |
|---|---|---|
| **1** | Service at Silver tier. Hardened CI PR merged. First green PR through the new `quality` job. `pre-commit install` run by every team member. | Watch CI duration; if anything jumped >30%, investigate before week 2. |
| **2** | `enable-contract-testing` template run; first contract registered; a deliberately breaking change has been blocked by the PreSync hook (so the team has *felt* the gate). | Verify contract-mcp-server health daily; document any new failure modes in `docs/contract-testing.md`. |
| **3** | E2E suite added; 3-5 user journeys covered; service shows Gold tier in scorecard. | Capture per-team adoption metrics; draft retro questions. |
| **4** | Retro: what worked, what was painful, what would you tell the next team. | Roll lessons into `docs/shift-left.md` v0.2; pick next 2 pilot teams; identify the top 3 platform improvements. |

### Week-4 retro — 60 minutes

**Format:** Lean Coffee. Each pilot team brings 3 cards. Platform team facilitates, doesn't bring cards.

**Mandatory questions to surface answers to:**
- Did the scorecard change your team's behaviour, or did you ignore it?
- Which gate gave you the most signal per unit of pain?
- Which gate gave you the *least*?
- What would have made the kickoff session more useful?
- Would you recommend this pilot to another team — yes / no / yes-with-changes?

**Outputs:**
- Public retro doc in `docs/shift-left-pilot-retro.md` (to be written at pilot close — not in the repo yet).
- Two named follow-on teams for round 2.
- Top-3 platform changes filed as issues against `backstage-platform-template`.

---

## 4. Roles

| Role | Owner | Responsibility |
|---|---|---|
| Programme owner | _[platform lead]_ | Goes/no-goes the pilot, signs off on retro, escalation point |
| Pilot facilitator | _[platform engineer]_ | Runs kickoff, Friday reviews, week-4 retro; main contact in Slack |
| Pilot driver | _[platform engineer]_ | Pairs with teams on hard problems; owns platform commitments from the weekly |
| QE observer | _[QE lead]_ | Listens for cross-team patterns; surfaces them into platform backlog |
| Team A pilot lead | _[team A tech lead]_ | Owns team A's progress; runs internal team coordination |
| Team B pilot lead | _[team B tech lead]_ | Same, team B |

---

## 5. What we'll measure at the end

These numbers go into the wrap-up readout to programme stakeholders.

| Metric | Source | Target |
|---|---|---|
| Days from kickoff → Silver | Scorecard timestamp diff | ≤7 |
| Days from kickoff → Gold | Same | ≤21 |
| PR P50 CI duration after hardening vs before | GitHub Actions duration metric | ≤+30% (we expect *some* increase from new jobs) |
| Vulns caught at PR (new) vs caught in prod (old) | `idp_scorecard_check_passed{check="has-vuln-scan"}` + Dependabot alerts | All new HIGH/CRITICAL caught at PR |
| Breaking-change deploys blocked | ArgoCD PreSync rejection events for `contract-check` job | ≥1 (we'll force one in week 2) |
| Team self-reported confidence (1–5) — before vs after | Anonymous form | +1 minimum |

---

## Appendix A — Slide cues for the facilitator

For the 00:00–00:10 "welcome" segment, only two slides:

**Slide 1 — Why now**
> "Defects caught in prod cost 10–100× what they cost at PR time. The platform already has the gates wired. We need two teams to prove the adoption path works. You're it."

**Slide 2 — The deal**
> "4 weeks. ~1 day per week. You get a Gold-tier service and a direct line to the platform team. We get evidence the path works. If at any point you think we're wasting your time, you tell us, and we fix it or end it."

That's the whole intro. No 30-slide deck. Get into the live walkthrough by 00:10.

---

## Appendix B — Pre-flight checklist for the facilitator

Do all of these the day before the kickoff. If any fail, postpone.

- [ ] Both pilot services are visible in Backstage with a scorecard rendering.
- [ ] `grafana.idp.local/d/scorecard` loads and shows both services.
- [ ] You can `git clone` both teams' service repos with your account.
- [ ] `enable-contract-testing` template runs successfully against a throwaway service end-to-end. (If it fails the day before the kickoff, the kickoff fails.)
- [ ] `playwright-e2e-suite` template demoable.
- [ ] `#shift-left-pilot` Slack channel created, both teams + platform team invited.
- [ ] The two slides are printed / open.
- [ ] You have the 4 weekly Friday slots blocked on both teams' calendars.
