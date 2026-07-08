# Contract Testing Demo — Recording Script

Everything below already happened live on the cluster this session. Nothing needs to be
re-run — just open these pages in order and narrate over them.

## Quick reference — all URLs

**Backstage** (base: `http://k8s-backstag-backstag-876d690111-e499f49b17353866.elb.us-east-1.amazonaws.com`)
- Create page: `/create`
- `payments-api` catalog entry: `/catalog/default/component/payments-api`
- `frontend-app` catalog entry: `/catalog/default/component/frontend-app`
- AI Assistant: `/ai-assistant`
- KAgent dashboard: `/kagent`

**GitHub**
- `payments-api` repo: https://github.com/moatazeldebsy/payments-api
  - PR #1 (add accounts endpoint, merged): https://github.com/moatazeldebsy/payments-api/pull/1
  - PR #3 (semver versioning + bump to 1.1.0, merged): https://github.com/moatazeldebsy/payments-api/pull/3
  - PR #4 (breaking rename to 2.0.0, **open/blocked**): https://github.com/moatazeldebsy/payments-api/pull/4
- `frontend-app` repo: https://github.com/moatazeldebsy/frontend-app
  - PR #1 (add contract test suite, merged): https://github.com/moatazeldebsy/frontend-app/pull/1

**Grafana**
- AI Platform Observability dashboard: http://k8s-monitori-promethe-8211311fd3-219291665.us-east-1.elb.amazonaws.com/d/ai-platform/ai-platform-observability?orgId=1&from=now-24h&to=now&timezone=browser&refresh=30s

## Step 1 — Scaffold the provider (Backstage)
Open Backstage → **Create** (`/create`) → show the **Node.js Service** template card
(proves it's a real golden-path template, not hand-rolled).
- Then jump to the **Catalog** entry for `payments-api`
  (`/catalog/default/component/payments-api`) to show it's registered.

## Step 2 — Register the provider spec (GitHub)
Open **[payments-api PR #1](https://github.com/moatazeldebsy/payments-api/pull/1)**
("add /api/accounts/{account_id} endpoint") — merged.
- Show the diff (adds the `currency` field).
- Scroll to the bot comment: *"No previous version registered — first-time contract
  registration."*

*(Skip PR #2 — it was an abandoned first pass before switching to semver versioning;
don't show it. Also skip PR #3 unless you want to explain the version-naming switch —
it's not essential to the core narrative.)*

## Step 3 — Scaffold the consumer (Backstage)
Same as step 1 but for **React Frontend** → `frontend-app` in the Catalog
(`/catalog/default/component/frontend-app`).

## Step 4 — Add contract testing to the consumer (GitHub)
Open **[frontend-app PR #1](https://github.com/moatazeldebsy/frontend-app/pull/1)**
("add payments-api-consumer contract test suite") — merged.
- Show the PR description listing what was added: `contract/openapi.yaml` +
  `.github/workflows/contract.yml`.
- Show the actual files in the repo at that commit (flat layout, not nested).

## Step 5 — Register the consumer contract (GitHub)
Open `frontend-app`'s commit history on `main`
(https://github.com/moatazeldebsy/frontend-app/commits/main) — find the commit
*"feat: declare dependency on /api/accounts/{account_id} currency field"*.
- Open the **Actions** tab (https://github.com/moatazeldebsy/frontend-app/actions) →
  the `Contract Tests` workflow run for that commit → show the green "Register Consumer
  Contract" job and its log line `Contract registered for frontend-app@<sha>`.

## Step 6 — Break the provider (GitHub)
Open **[payments-api PR #4](https://github.com/moatazeldebsy/payments-api/pull/4)**
("rename currency to currencyCode, bump to 2.0.0 (breaking)") — **still open, still
failing**. This is the money shot.
- Show the failing `Contract Check` status check.
- Scroll to the two bot comments:
  - ❌ breaking change detected (`response_property_removed`, field `currency`)
  - 🚧 the generated migration guide naming `frontend-app` as an affected consumer.
- Point out the merge is blocked by CI (only `Contract validation` is red — `Lint` and
  `Test + Coverage Gate` both pass, so it's clear the block is specifically about the
  contract, not incidental CI flakiness).

## Step 7 — Ask the AI Assistant (Backstage)
Open Backstage → **AI Assistant** (`/ai-assistant`). Ask, in order (use these exact
strings — they're the real registered version identifiers, not placeholders):

1. `Can I deploy payments-api version 1.1.0-pr-3?` → ✅ safe
2. `Can I deploy payments-api version 2.0.0-pr-4?` → ❌ not safe, `currency` removed
3. `Which consumers are blocked if I deploy payments-api version 2.0.0-pr-4?` → `frontend-app`
4. `Generate a migration guide for payments-api going from 1.1.0-pr-3 to 2.0.0-pr-4`

Good optional add-ons if you want a longer cut:
- `Show me the compatibility report for payments-api`
- `Show me the recent audit log for contract-mcp-server`

## Bonus — show the machinery (kagent dashboard)
Open Backstage → **KAgent** (`/kagent`). This hits the real Kubernetes API for the
`Agent` custom resources, so it should show `platform-assistant` live with its real tool
count and (if Prometheus has data) call metrics — good for "this isn't a black box,
here's the actual agent config and its tool calls" framing.

> Caveat: this page silently falls back to canned demo numbers if the K8s API call fails
> for any reason (e.g. proxy hiccup). If the agent list looks suspiciously static/round,
> refresh once before recording that segment to make sure you're on the live path, not
> the fallback.

## Bonus — show real metrics (Grafana)
Open the **[AI Platform Observability dashboard](http://k8s-monitori-promethe-8211311fd3-219291665.us-east-1.elb.amazonaws.com/d/ai-platform/ai-platform-observability?orgId=1&from=now-24h&to=now&timezone=browser&refresh=30s)**
(pre-set to the last 24h, auto-refreshing every 30s — covers this whole session's demo
traffic). Good for grounding the AI Assistant answers in real numbers: MCP tool call
volume, per-agent/per-tool breakdowns, and latency — reinforces that `can_i_deploy`,
`get_compatibility_report`, etc. are real backend calls, not scripted responses.

> This requires a Grafana login (redirects to `/login` if the session isn't already
> authenticated in your browser) — log in before you start recording this segment so the
> dashboard loads directly instead of showing the login screen on camera.

## Closing — summary to say after the demo

Everything you just watched maps to the talk's learning objectives — say this explicitly,
don't assume the audience connects the dots on their own:

- **MCP as the context layer.** Every service exposes its live contract over MCP
  (`fetch_service_contract`, `auto_discover_contracts`) — that's what let `payments-api`
  register itself with zero manual Pact-suite authoring (Step 2).
- **Traditional contract testing's failure mode, shown live.** PR #4 is exactly the
  incompatibility that static specs and hand-maintained suites miss until production —
  here it's caught and blocked before merge (Step 6).
- **Self-describing → self-testing, automatically.** `generate_contract_tests` turned
  `frontend-app`'s dependency on the `currency` field into real Pact tests with schema
  matchers, not boilerplate status-code checks (Step 4/5).
- **CI/CD integration.** The block on PR #4 is a real failing GitHub status check, not a
  chat answer — `Contract validation` is red while `Lint` and `Test + Coverage Gate` stay
  green, isolating the cause (Step 6).
- **Breaking changes reduced, concretely.** `can_i_deploy`, the named blocked consumer,
  and the generated migration guide (Step 7) are the reduce-breaking-changes story end to
  end — detect → name the blast radius → hand the consumer a fix path.

**Then name the two code paths and their risk profile — this is the trade-offs/governance
ask from the abstract, and it's the part that's easy to skip if you're rushing:**

- The CI gate (`contract-check.yml`, the ArgoCD hooks) calls `detect_breaking_changes` /
  `validate_compatibility` directly over HTTP. Pure schema diffing, no model in the loop,
  deterministic — that's what's safe to gate a merge on.
- The AI Assistant chat in Step 7 goes through an LLM that calls the same tools and then
  paraphrases the JSON result. Useful for exploration, but the tool result (and the audit
  log) is the source of truth — not the sentence the assistant wrote around it.
- Governance today is an audit log (`get_audit_log` — who registered what, when) plus an
  optional `API_KEY` gate on writes. What's *not* there yet: an approval workflow for
  overwriting a registered contract, and role separation between "can register a contract"
  and "can override a breaking-change block." Naming that gap out loud is more credible
  than pretending it's solved.

Close on: *"The AI layer makes this conversational and discoverable — but the thing you'd
actually want to gate a production deploy on is the deterministic tool call underneath it,
not the chat transcript. That distinction is the governance model."*
