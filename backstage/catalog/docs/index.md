# QA Platform & Quality Enablement

This capability provides the golden-path tooling for test quality across all services in the IDP.

## Features

- **Golden-path testing scaffolds** — Playwright E2E, k6 performance, Pact contract templates
- **CI quality gates** — SonarCloud SAST enforced on every PR; blocks on blocker/critical issues
- **Cross-browser E2E** — LambdaTest integration for Playwright suites across 3000+ browser/OS combos
- **QA KPI dashboards** — Grafana dashboards tracking test pass rates, flakiness, and coverage trends

## Owned Resources

| Resource | Purpose |
|---|---|
| SonarCloud | SAST & code-quality gate |
| LambdaTest | Cross-browser cloud testing grid |
| Mailtrap | Email sandbox for CI testing |

## Links

- [QA Metrics Dashboard](http://grafana.idp.local/d/qa-metrics/qa-metrics)
- [Playwright E2E Reports](https://github.com/moatazeldebsy/idp-mvp/actions)
