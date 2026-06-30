# Shift-Left Demo Cheatsheet

A one-page presenter script for demoing the shift-left programme. Keep this open on a second monitor. Each row is one "beat" of the demo: what to click, what to break, what the audience should see catch it.

For the why and the gate definitions, see [shift-left.md](shift-left.md). This page is the *what to do live*.

---

## Pre-flight (10 min before)

- [ ] `bootstrap-local.sh --print-urls` — confirm all URLs resolve
- [ ] Open these tabs in order: Backstage → `/create`, Backstage scorecard tab on a sample service, Grafana scorecard dashboard, ArgoCD UI, a terminal in a throwaway service repo
- [ ] `docker ps` — Backstage + Postgres healthy
- [ ] Backstage built from a freshly-built image (see [local-setup.md](local-setup.md) — run `docker compose -f local/backstage/docker-compose.yml up -d backstage` if you just rebuilt)
- [ ] Have a throwaway service repo at the ready (a previously-scaffolded `demo-svc`) — for Beat 1 & 2 (scaffold + Trivy)
- [ ] **Beat 3 (contract testing):** `payments-api` is already deployed and registered — confirm: `curl http://contract-mcp-server.idp.local/api/contracts` returns `payments-api v1.0.0`
- [ ] Have a branch ready with `currency` removed from `Account` in `services/payments-api/src/main.py` — use this for the "break it" step instead of doing it live if you're nervous
- [ ] Mute Slack

---

## The demo, 4 beats, ~15 minutes

### Beat 1 — Scaffold lands you at Silver (3 min)

| Step | Action | What the audience sees |
|---|---|---|
| 1 | Backstage `/create` → pick `go-service` (or `nodejs-service`) | Template form |
| 2 | Fill `name: demo-svc`, owner, then **Create** | Scaffolder runs ~30s |
| 3 | Open the new repo's `.github/workflows/ci.yml` | Lint + Trivy + coverage + container-smoke jobs already wired |
| 4 | Open the entity in Backstage → **Scorecard** tab | 🥉 Bronze ✅, 🥈 Silver ✅, 🥇 Gold dimmed |

**The line:** *"They didn't write a single CI file. They picked a template. They're already at Silver."*

---

### Beat 2 — PR-time gate catches a vulnerability (3 min)

| Step | Action | What the audience sees |
|---|---|---|
| 1 | In `demo-svc`, edit `go.mod` (or `package.json`) to pin a known-vulnerable dep — e.g. `lodash@4.17.20` | — |
| 2 | Open a PR | GitHub Actions runs |
| 3 | Watch the `quality` job — Trivy step | **FAILED** with HIGH/CRITICAL CVE listed |
| 4 | Try to merge | `publish` is blocked — `needs: [test, quality]` |

**The line:** *"This is a vuln that would have shipped six months ago. Now it doesn't leave the PR."*

> If short on time, **skip the PR open** and just show a prior PR where this happened — keep a screenshot in your pocket.

---

### Beat 3 — Deploy-time gate blocks a breaking API change (4 min)

This is the showstopper. Don't skip it.

**Pre-registered:** `payments-api` contract is already in the registry (`GET /api/contracts` → confirm live). Use it as the provider for this beat.

| Step | Action | What the audience sees |
|---|---|---|
| 1 | Open AI Assistant (`/ai-assistant`) → select **contract-assistant** → type: *"List all registered contracts"* | `payments-api v1.0.0` with 6 paths listed |
| 2 | Ask: *"Can I deploy payments-api v1.0.0?"* | `safe: true` — no consumers are blocked |
| 3 | In `services/payments-api/src/main.py`, remove `currency` from the `Account` response model → push as a PR branch | GitHub Actions runs `contract-check.yml` |
| 4 | Show the PR — a bot comment appears: *"Breaking change detected: removed field `currency` from `GET /api/accounts/{account_id}`"* | Diff summary + migration guide link in PR comment |
| 5 | Ask AI Assistant: *"Can I deploy payments-api v1.1.0?"* | `safe: false` — blocked, with reason |
| 6 | Revert the field → merge → ArgoCD PreSync hook passes | Deploy proceeds; ask *"Can I deploy payments-api v1.0.0?"* → `safe: true` again |

**The line:** *"The contract is registered automatically. The breaking change is detected automatically. The deploy is blocked automatically. Nobody wrote a Pact file."*

> **If short on time (2 min version):** Skip steps 3-4. Just show steps 1-2 (list contracts + can-i-deploy safe), then jump to step 5 using a pre-broken branch you prepared earlier. Show the blocked result. Revert live or switch to the fixed branch.

> **Recovery:** If AI Assistant is slow, use `curl http://contract-mcp-server.idp.local/api/can-i-deploy/payments-api/1.0.0` in terminal — same result, just less visual.

---

### Beat 3b — Audit trail and stale contracts (optional, 2 min)

Add this if you have time or the audience asks "how do we know what happened?":

| Step | Action | What the audience sees |
|---|---|---|
| 1 | AI Assistant: *"Show me the audit log for the last 10 actions"* | Timestamped list: `register_contract`, `can_i_deploy`, `detect_breaking_changes` with agent ID and service name |
| 2 | AI Assistant: *"Are there any stale contracts?"* | List of services not updated in 30+ days (or empty if everything is fresh) |

**The line:** *"Every tool call is logged. You know who asked, what they asked, and when. The audit log is queryable by service, action, or agent."*

---

### Beat 4 — Runtime loop closes the feedback cycle (2 min)

| Step | Action | What the audience sees |
|---|---|---|
| 1 | Open Grafana → Scorecard dashboard | `idp_scorecard_tier_silver` count incremented (your demo-svc lit up) |
| 2 | Open the per-check heatmap panel | Green columns across the board |
| 3 | Open the Flaky Tests panel | If you have a flaky test from a prior run, point at the top row |
| 4 | Click through to the Backstage **Scorecard** tab for any service | Same data, surfaced where the team lives |

**The line:** *"Same metric, two audiences. Service teams see their tier in Backstage. Platform team sees the fleet roll-up in Grafana. Both update every 15 minutes."*

---

## Template-to-stage map (for the Q&A)

If someone asks "what about X?", here's what to point at without leaving the deck:

| Audience question | Template | Stage it adds |
|---|---|---|
| "How do we add unit tests to an existing service?" | `unit-test-suite` (brownfield, language-aware) | PR loop — unit + coverage gate |
| "Component tests without spinning up a real DB?" | `component-test-suite` (WireMock-stubbed deps) | PR loop — component tests |
| "How do we test against a real database?" | `testcontainers-suite` | PR loop — integration tests |
| "What about Terraform / IaC?" | `iac-test-suite` (tflint + Checkov + optional Terratest) | PR loop — IaC gate |
| "What about end-to-end?" | `playwright-e2e-suite` | PR loop — E2E (Gold tier) |
| "API-only service, no UI?" | `newman-api-suite` | PR loop — E2E alternative |
| "We need performance/load tests" | `k6-performance-suite` | PR loop — perf gate |
| "What about security scanning beyond Trivy?" | `zap-dast-suite` | PR loop — DAST |
| "We have an LLM agent" | `deepeval-llm-eval-suite` | PR loop — eval |
| "Mobile app?" | `appium-mobile-suite` | PR loop — mobile E2E |
| "Accessibility?" | `accessibility-suite` (axe-core) | PR loop — a11y |
| "Visual regression?" | `visual-regression-suite` | PR loop — visual |
| "Chaos / resilience?" | `chaos-mesh-suite` | Runtime loop |
| "Synthetic monitoring in prod?" | `datadog-synthetic-suite` | Runtime loop |
| "Mutation testing?" | `mutation-testing-suite` (Stryker) | PR loop — Gold+ aspiration |

---

## "What if it breaks live?" recovery moves

| Symptom | Move |
|---|---|
| Scaffolder spins forever | `docker logs backstage-backstage-1 \| tail -30` in a side terminal — usually a template form validation issue. Skip to Beat 2. |
| `enable-contract-testing` action errors out | Fall back to the pre-recorded screencast (keep one ready). Don't debug live. |
| ArgoCD sync wedged | `kubectl rollout restart deployment/argocd-application-controller -n argocd` — but really, just skip to Beat 4 and use a prior PR's screenshot. |
| Grafana panel empty | The 15-min exporter hasn't run yet. Open the prior week's snapshot. |
| Backstage 500s after rebuild | You forgot to recreate the container after `docker compose build`. Run `docker compose -f local/backstage/docker-compose.yml up -d backstage`. |

**Golden rule for the demo:** if something fails live, **do not debug on stage**. Cut to the screencast, finish the beat, and address it in Q&A. The narrative beats the demo gods every time.

---

## The 30-second close

End on this, verbatim:

> *"Three things changed. One: developers stopped writing CI — the template ships it. Two: the breaking-change conversation moved from a Slack thread after the incident, to a PreSync job before the deploy. Three: every team now sees the same scorecard the platform team sees. That's shift-left. The path to Gold is two scaffolder clicks."*

Then take questions. The template-to-stage map above is your safety net.
