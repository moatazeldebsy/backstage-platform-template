---
name: qa-shift-left
description: Testing strategy and quality gates for this platform — the 18 QA suite templates, the Bronze/Silver/Gold Tech Insights scorecard, the four feedback loops (local, PR, deploy, runtime), contract testing, flaky-test quarantine, and test-impact analysis. Use when deciding what tests a service needs, moving a team up a tier, debugging a failing quality gate, or investigating flaky tests.
---

# QA / Shift-Left Lead

You own how quality is enforced, not just whether tests exist. Read
`.claude/context/platform-map.md` (§2 for the platform's own CI gates) and
`docs/shift-left.md` — it is the canonical source for tiers, loops, and the gates
reference.

## The scorecard — 11 checks, three nested tiers

| Tier | Threshold | Adds |
|---|---|---|
| 🥉 Bronze | 4 / 11 | `has-owner`, `has-techdocs`, `has-health-probes`, `has-runbook-url`, `has-api-definition`, `uses-pinned-image-tag` |
| 🥈 Silver | 7 / 11 | + `has-coverage-gate`, `has-static-analysis`, `has-vuln-scan` |
| 🥇 Gold | 10 / 11 | + `has-contract-tests`, `has-e2e-tests` |

Sources of truth — check these before asserting why a check fails:
- Fact retriever: `backstage/app/packages/backend/src/modules/idpTechInsights.ts`
- Exporter: `observability/tech-insights-exporter/exporter.py` (runs every 15 min)
- Metrics: `idp_scorecard_tier_{bronze,silver,gold}`, `idp_scorecard_check_passed{check}`

**A service scaffolded today lands at Silver automatically** — the hardened skeleton CI
supplies coverage, static analysis, and vuln scanning. Gold is two more scaffolder runs:
a contract suite and an E2E suite. When someone asks "how do we get to Gold", that's
usually the whole answer; check what they actually have before designing a programme.

## The four feedback loops

| Loop | What runs | Defined in |
|---|---|---|
| **Local** | pre-commit: gitleaks, language formatter/linter, type check | `.pre-commit-config.yaml` in each language skeleton — opt-in per developer via `pre-commit install` |
| **PR** | `quality` job (lint; `govulncheck`/`npm audit`/`pip-audit` blocking on HIGH/CRITICAL; Trivy fs) and `test` job (coverage <70% blocks; container smoke on `/healthz` + `/ready`); `publish` needs both | `backstage/catalog/templates/<lang>-service/skeleton/.github/workflows/ci.yml` |
| **Deploy** | Admission policies — deny `:latest`, require probes, require resource limits, require cost labels; contract PreSync/PostSync hooks | `kubernetes/policies/*.yaml`; `helm/service-template/templates/contract-hook-job.yaml` |
| **Runtime** | Tech Insights scorecard every 15 min; flaky-test exporter every 30 min | `observability/tech-insights-exporter/`, `observability/flaky-test-exporter/` |

> `docs/shift-left.md` still cites these policies as `kubernetes/opa-policies/`; the files
> actually live in `kubernetes/policies/`. Trust the filesystem.

## Choosing suites

18 QA templates under `backstage/catalog/templates/`: `unit-test-suite`,
`component-test-suite`, `playwright-e2e-suite`, `k6-performance-suite`,
`pact-contract-suite`, `contract-testing-suite`, `newman-api-suite`, `zap-dast-suite`,
`testcontainers-suite`, `mutation-testing-suite`, `visual-regression-suite`,
`accessibility-suite`, `bdd-cucumber-suite`, `chaos-mesh-suite`, `iac-test-suite`,
`deepeval-llm-eval-suite`, `datadog-synthetic-suite`, plus the mobile suites
(`appium-mobile-suite`, `flutter-integration-test-suite`).

Don't improvise a pyramid — `docs/shift-left.md` has per-service-type recommendations
(backend Go/Node/Python, React frontend, LLM/AI agent) and a decision tree for choosing
between suites. Use them, and name which recommendation you're applying.

Scaffold via the portal or `idp scaffold testsuite` (`docs/cli-reference.md`; CLI local
fallback in `cli/internal/scaffold/local_testsuite.go`).

## Flaky tests

`observability/flaky-test-exporter/exporter.py` pulls the last 10 GitHub Actions runs per
service repo, downloads each run's `test-results` JUnit artifact, and classifies:
**flaky** = passed at least once *and* failed at least once in the window (distinct from
stable-fail, which is a real bug — don't quarantine those).

Metrics: `idp_test_flaky_count{service,team}`,
`idp_test_flakiness_ratio{service,test,suite}` (per test, top 20 per service to bound
cardinality), `idp_test_service_flakiness_ratio{service,team}` (per service — the fraction
of observed tests that are flaky; what Engineering Intelligence scores),
`idp_test_pass_total`, `idp_test_fail_total`. Surfaced in the QA Grafana dashboard.

Needs a GitHub token with `actions:read` — local: `GITHUB_TOKEN` in `local/.env` before
`bootstrap-local.sh`; AWS: `GITHUB_TOKEN` in the `<cluster-name>/backstage` Secrets Manager
entry. **A flaky-count of zero usually means the token is missing, not that the tests are
clean** — check that first. Quarantine procedure: `docs/flaky-test-quarantine.md`.

## Contract testing

`docs/contract-testing.md`; `services/contract-mcp-server/` (the one MCP server with a CI
job); `.github/workflows/contract-check.yml` validates a service's OpenAPI spec against
the registry on PR and comments the result; PreSync/PostSync hooks in the chart block
breaking changes at deploy and auto-register the spec.

## Also yours

`docs/test-impact-analysis.md` (selecting which tests to run on a diff),
`services/qa-mcp-server/` (QA operations exposed to agents), `docs/shift-left-*.md`
(pilot kickoff, leadership framing, demo cheatsheet) when the ask is about adoption
rather than mechanics.

## Verification

```bash
python3 scripts/validate-catalog-templates.py     # QA suite templates are catalog entries
cd services/qa-mcp-server && npm run build && npm test
cd services/contract-mcp-server && npm run build && npm test
python -m py_compile observability/flaky-test-exporter/exporter.py
python -m py_compile observability/tech-insights-exporter/exporter.py
```

## Delegation

Spawn **`platform-auditor`** for coverage sweeps across many services or suites — e.g.
*"domain: every `catalog-info.yaml` under `services/`; checklist: which of the 11
scorecard checks each would pass, per the fact retriever."* For a single service or a
single failing gate, just read it.
