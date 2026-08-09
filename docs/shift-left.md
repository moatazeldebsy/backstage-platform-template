# Shift-Left Quality Engineering

This page is the programme overview for embedding quality earlier in the lifecycle on this platform. It is aimed at three audiences:

- **Service teams** — what gates apply to your service, how to clear them, what tier you land at.
- **Platform team** — what the IDP provides and how to extend it.
- **Programme owners** — what to measure and how to track adoption.

The TL;DR: the platform already enforces shift-left at scaffold, PR, and deploy time. This page tells you exactly where, and how to move a service from Bronze to Gold.

## Why this exists

Defects caught in production cost 10–100× what they cost in a developer's editor. Shift-left means moving detection upstream: into the IDE, the pre-commit hook, the PR build, the contract check at deploy time. The goal is faster feedback, fewer escaped defects, and confidence to release more often.

The platform's contribution is **paving the path**: every gate below is wired into a scaffolder template, so adoption is "click the template" rather than "read this 40-page guide and reimplement it."

## The four feedback loops

Each loop runs against a different signal and at a different speed. They compose.

| Loop | Where it runs | Latency | What it catches |
|---|---|---|---|
| **Local** | Developer machine | <1s | Syntax, type errors, lint, format |
| **PR** | GitHub Actions on every push/PR | 2–5 min | Coverage gaps, vulnerable deps, secrets, container smoke failures |
| **Deploy** | ArgoCD sync hook | seconds | Breaking API change, OPA policy violation |
| **Runtime** | Prometheus + Tech Insights scorecard | 15 min | Drift from quality gates, missing runbook, scorecard regression |

Tools and gates for each loop are in the [Gates Reference](#gates-reference) below.

## The scorecard tiers

Every Component in the Backstage catalog is scored against 11 checks. Tiers nest: Gold implies Silver implies Bronze.

| Tier | Threshold | Means | What's checked |
|---|---|---|---|
| 🥉 **Bronze** | 4 / 11 | Baseline service hygiene | `has-owner`, `has-techdocs`, `has-health-probes`, `has-runbook-url`, `has-api-definition`, `uses-pinned-image-tag` |
| 🥈 **Silver** | 7 / 11 | + Shift-left CI gates | + `has-coverage-gate`, `has-static-analysis`, `has-vuln-scan` |
| 🥇 **Gold** | 10 / 11 | + Contract + E2E tests | + `has-contract-tests`, `has-e2e-tests` |

Sources of truth:
- Fact retriever: `backstage/app/packages/backend/src/modules/idpTechInsights.ts`
- Exporter (Pushgateway / CloudWatch): `observability/tech-insights-exporter/exporter.py`
- Grafana metrics: `idp_scorecard_tier_{bronze,silver,gold}`, `idp_scorecard_check_passed{check}`

A service scaffolded today from any language template lands at **Silver** automatically — the hardened CI provides coverage, static analysis, and vuln scanning out of the box. Moving to Gold takes two scaffolder runs (contract suite + e2e suite).

## Adoption playbook — for a team going Bronze → Gold

This is the path for a pilot team. Plan ~3 working days end-to-end; ~half a day if you only have one service.

> Running this as a formal pilot with two teams? See **[Shift-Left Pilot Kickoff](shift-left-pilot-kickoff.md)** for the kickoff agenda, weekly cadence, and retro template.

### Day 1 — Land at Silver

1. **Scaffold the service** through Backstage `/create` (or `idp scaffold service --name <svc> --type {nodejs,go,python}`). This gives you:
   - A repo on GitHub with the hardened CI (`/.github/workflows/ci.yml`) already wired.
   - `catalog-info.yaml` containing `idp.io/quality-gates: "coverage,static-analysis,vuln-scan"`.
   - `helm-values-{local,dev}.yaml` already declaring health probes and resource limits.
2. **Verify the scorecard** — open the service in Backstage → Tech Insights tab. You should see Bronze + Silver tier lit; Gold dimmed.
3. **Push a no-op commit** to trigger CI. The new `quality` and `test` jobs should both go green; `publish` requires both.
4. **Watch the DORA dashboard** in Grafana (`http://grafana.idp.local/d/dora/dora-metrics`) — lead time for changes on your service starts logging.

### Day 2 — Add contract testing (move toward Gold)

5. **Run the `enable-contract-testing` Backstage template** against your existing repo. This:
   - Adds `GET /openapi.json` to your service.
   - Deploys the `contract-mcp-server` if not already in-cluster.
   - Auto-registers your contract.
   - Wires an ArgoCD PreSync hook that **blocks any deploy that introduces a breaking API change**.
   - Adds `contract` to `idp.io/quality-gates`.
6. **Try to ship a breaking change** in a feature branch — remove a field from your OpenAPI spec, push, watch ArgoCD reject the sync. This is the muscle the gate is meant to build.

### Day 3 — Add E2E suite (Gold)

7. **Run the `playwright-e2e-suite` template** with `add to existing` mode targeting your service repo. The suite scaffolder opens a PR on the service repo that:
   - Adds Playwright TypeScript tests.
   - Adds a `playwright` GitHub Actions workflow.
   - Adds the `e2e` tag and `idp.io/quality-gates: ...,e2e` to your catalog-info.
8. **Merge the PR**. The Tech Insights refresh (every 15 min) picks up the new annotation; the scorecard tips to Gold.

### Day 4 onward — Operate

9. **Set a weekly review cadence**: 15 min looking at the team's panel in the IDP scorecard Grafana board. Any check that flipped from passing → failing is a regression and gets triaged.
10. **Add a flaky-test quarantine policy**: when CI flakes the same test twice in a week, the test is auto-quarantined and a Jira ticket created. (Flaky-test exporter is on the roadmap — see the [GitHub Project](https://github.com/users/moatazeldebsy/projects/5).)

## Test pyramid — recommendations per service type

The platform doesn't *enforce* a pyramid shape, but here's the recommended starting mix.

### Backend service (Node.js / Go / Python)

| Layer | Suite | When to add | Maintained by |
|---|---|---|---|
| Unit | Built into language skeleton — or `unit-test-suite` template for brownfield repos | Day 1 | Service team |
| Component | `component-test-suite` template (WireMock-stubbed deps) | When the service has external HTTP calls but no real DB/Kafka in CI | Service team |
| Integration | `testcontainers-suite` template | When the service has a DB / Kafka / Redis dep | Service team |
| Contract | `enable-contract-testing` template | Day 2 | Service team (Pact consumer + provider) |
| E2E | `playwright-e2e-suite` (golden path) or `newman-api-suite` (API-only) | When the service is user-facing | Service team |
| Performance | `k6-performance-suite` template | Before any traffic increase ≥2× | Service team, shared k6 baseline |
| Security | `zap-dast-suite` template | Before going public | Service team + security |
| IaC | `iac-test-suite` template (tflint + Checkov + optional Terratest) | Any repo with Terraform | Service team or platform team for shared modules |

### Frontend (React)

| Layer | Suite | When to add |
|---|---|---|
| Unit | Vitest (in skeleton) | Day 1 |
| Component | Vitest + React Testing Library (in skeleton) | Day 1 |
| E2E | `playwright-e2e-suite` | Day 2 |
| Visual | `visual-regression-suite` | Before any redesign |
| Accessibility | `accessibility-suite` (axe-core) | Day 2 — non-negotiable for any user-facing surface |

### LLM / AI agent

| Layer | Suite |
|---|---|
| Eval | `deepeval-llm-eval-suite` — runs prompt regression + hallucination checks |
| Behavioural | `bdd-cucumber-suite` — Gherkin specs for agent flows |

## Choosing between suites — decision tree

> **You only need one contract suite per service.** `enable-contract-testing` (MCP-driven, auto-discovery) is the platform default; `pact-contract-suite` is the legacy explicit-Pact template. Use the former unless you have a hard requirement on PactFlow broker.

```
Do you have an OpenAPI spec on the service?
├── Yes → use enable-contract-testing (auto-discovery + breaking-change gate)
└── No  → use pact-contract-suite (manual Pact contracts)
```

```
Is the service user-facing?
├── Yes → playwright-e2e-suite
└── No  → newman-api-suite or skip — let contract tests carry it
```

```
Does the service have a database or message bus?
├── Yes → testcontainers-suite (real Postgres/Kafka in CI; no mocks)
└── No  → skip, unit tests are enough
```

## Gates Reference

This is the canonical list of gates the platform enforces. Each row is one PR/deploy/runtime check.

### Local loop

| Gate | How to run | Where defined |
|---|---|---|
| Pre-commit hooks | `pip install pre-commit && pre-commit install` once per clone | `.pre-commit-config.yaml` in each language skeleton (shipped) |
| Linter | Same hook bundle (or `make lint` if you prefer) | Per language: `golangci-lint` / `ruff` / `tsc` / `prettier` |
| Type check | Pre-commit hook for TS; `mypy` runs in CI quality job for Python | Same |
| Secret scan | `gitleaks` runs in pre-commit | Same |

Every language skeleton now ships with a `.pre-commit-config.yaml` covering `gitleaks` (always-on secret scan), language-specific formatters/linters (`ruff` + `ruff-format` for Python, `prettier` + `node --check`/`tsc` for JS/TS, `go-fmt` + `go-vet` + `go-mod-tidy` for Go), and the standard `pre-commit-hooks` set (trailing whitespace, large-file guard, merge-conflict marker check). It's **opt-in per developer** — adoption is `pre-commit install` once.

### PR loop (GitHub Actions on push / pull_request)

| Gate | Behavior | File |
|---|---|---|
| `quality` job: lint | Blocks PR if `golangci-lint` / `ruff + mypy` / `tsc + prettier` fails | `backstage/catalog/templates/<lang>-service/skeleton/.github/workflows/ci.yml` |
| `quality` job: dependency vuln | Blocks on HIGH/CRITICAL: `govulncheck` / `npm audit` / `pip-audit` | Same |
| `quality` job: Trivy fs | Blocks on HIGH/CRITICAL CVEs, leaked secrets, Dockerfile misconfig | Same |
| `test` job: coverage | Blocks if coverage <70% (lines/stmts/funcs) | Same |
| `test` job: container smoke | Blocks if `/healthz` or `/ready` don't respond inside the freshly built image | Same |
| `publish`: requires both | `publish` job has `needs: [test, quality]` | Same |
| Test artifacts | JUnit XML + coverage report uploaded for 7 days | Same |

### Deploy loop (ArgoCD)

| Gate | Behavior | File |
|---|---|---|
| OPA — deny `:latest` tags | Rejects pods at admission | `kubernetes/policies/deny-latest-tag.yaml` |
| OPA — require probes | Rejects pods without `livenessProbe` + `readinessProbe` | `kubernetes/policies/require-health-probes.yaml` |
| OPA — require resource limits | Rejects pods without `resources.limits` | `kubernetes/policies/require-resource-limits.yaml` |
| OPA — require cost labels | Rejects pods without cost-allocation labels | `kubernetes/policies/require-cost-tags.yaml` |
| Contract PreSync hook | Blocks deploy on breaking API change | `helm/service-template/templates/contract-hook-job.yaml` |
| Contract PostSync hook | Auto-registers spec; runs compatibility report | Same |

### Runtime loop (Tech Insights scorecard)

Runs every 15 minutes (`observability/tech-insights-exporter/cronjob.yaml`). Pushes metrics to:
- Local: Prometheus Pushgateway (`pushgateway.idp.local`)
- AWS: CloudWatch namespace `IDP/TechInsights`

Surfaced in:
- **Backstage** — every Component entity has a **Scorecard** tab (custom UI in `backstage/app/packages/app/src/extensions.tsx`) showing the 11 checks grouped by Hygiene / Shift-Left CI / Test Coverage, a tier badge (Bronze/Silver/Gold), and a "cheapest unfilled check" hint pointing the team at the next step.
- **Grafana** — Scorecard dashboard. Per-tier panels (`idp_scorecard_tier_{bronze,silver,gold}`) and per-check heatmap (`idp_scorecard_check_passed{check}`).

### Flaky-test detection (every 30 min)

A second runtime loop runs alongside the scorecard. The Flaky-Test Exporter (`observability/flaky-test-exporter/exporter.py`) pulls the last 10 GitHub Actions workflow runs per service repo, downloads each run's `test-results` JUnit artifact, and classifies every test:

| Classification | Definition |
|---|---|
| Stable pass | passed in every observed run |
| Stable fail | failed in every observed run (a real bug, not flake) |
| **Flaky** | passed at least once **and** failed at least once in the window |

Metrics published (Pushgateway local, CloudWatch on AWS):
- `idp_test_flaky_count{service,team}` — headline number per service
- `idp_test_flakiness_ratio{service,test,suite}` — emitted only for currently-flaky tests, capped at the top 20 per service to bound cardinality
- `idp_test_pass_total{service}`, `idp_test_fail_total{service}` — window totals

Surfaced in the QA Grafana dashboard ("Flaky Tests" panel, "Top Flaky Tests" table, "Test Outcomes in Window" timeseries).

**Setup:** requires a GitHub token with `actions:read` on the service repos. Local: set `GITHUB_TOKEN` in `local/.env` before `bootstrap-local.sh`. AWS: stored in `idp-mvp/backstage` Secrets Manager as `GITHUB_TOKEN`.

## Adoption metrics — what to track for the programme

These are the success-measure-3 numbers ("Improve CI feedback speed, test reliability, release confidence"). Each has a query you can paste into Grafana.

| Metric | Promql | Target |
|---|---|---|
| Services at Silver tier or higher | `sum(idp_scorecard_tier_silver)` | Steady ↑ |
| Services at Gold tier | `sum(idp_scorecard_tier_gold)` | Steady ↑ |
| Coverage gate adoption rate | `avg(idp_scorecard_check_passed{check="has-coverage-gate"})` | →1.0 |
| CI P50 duration on PR | `histogram_quantile(0.50, sum(rate(github_actions_workflow_duration_seconds_bucket{workflow="CI",event="pull_request"}[7d])) by (le))` | <5 min |
| Change failure rate (DORA) | Existing DORA dashboard panel | ↓ |
| Lead time for changes (DORA) | Existing DORA dashboard panel | ↓ |
| Flaky tests per service | `idp_test_flaky_count` | ≤2 per service |
| Pass rate in flake window | `idp_test_pass_total / (idp_test_pass_total + idp_test_fail_total)` | >0.95 per service |

## Enablement materials

- **This document** — programme overview (Success Measure 1 ✅).
- **Per-template TechDocs** — every Backstage scaffolder template has its own MkDocs guide at `backstage/catalog/templates/<name>/docs/`.
- **Contract testing deep-dive** — [docs/contract-testing.md](contract-testing.md).
- **Security posture** — [docs/security.md](security.md).
- **Runbooks** — [docs/runbooks/index.md](runbooks/index.md).

## FAQ

**Why 70% coverage and not 80% / 90%?** Because a hard floor that teams can clear is more useful than an aspirational one they treat as advisory. 70% catches most regression cliffs without forcing tests of trivial getters. Teams can raise the threshold in their own `package.json` / `ci.yml` once they're comfortably above it.

**My team has a legacy service that can't hit Silver. What now?** Add the missing annotations to `catalog-info.yaml` *as TODOs* (e.g., omit `idp.io/quality-gates`) so the scorecard reflects reality. Then pick the cheapest gate to add — usually `has-vuln-scan` (just add the Trivy step) — and incrementally close the gap. The scorecard's job is to show progress, not to shame.

**Can I disable a gate for my service?** Locally: yes, remove the relevant step from your CI. Centrally enforced gates (OPA, ArgoCD PreSync) are not opt-out — they apply at cluster boundaries. If a gate is genuinely wrong for your service, raise an issue against the platform repo; we'd rather change the gate than make exceptions.

**What about mutation testing?** The `mutation-testing-suite` template exists (Stryker). It's currently opt-in and not part of any tier — mutation scores are noisy and slow. It's a Gold+ aspiration; recommend adding it after a service is stably at Gold.

## Out of scope (yet)

Tracking these in the [GitHub Project](https://github.com/users/moatazeldebsy/projects/5):

- **Mutation testing in tier model** — once teams have stabilised at Gold.
- **PR-time test impact analysis** — only run perf/e2e on changes to relevant paths.

## Changelog for this page

| Date | Change |
|---|---|
| 2026-05-20 | Initial publish — covers hardened skeleton CI, expanded scorecard tiers, contract + e2e gates. |
