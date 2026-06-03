# QA Platform & Quality Enablement

This capability provides the golden-path tooling for test quality across all services in the IDP.
Engineers can self-service a complete test suite in minutes — either through the Backstage UI or the CLI.

## Features

- **18 golden-path testing scaffolds** — every major test type covered (see table below)
- **CI quality gates** — SonarCloud SAST enforced on every PR; blocks on blocker/critical issues
- **Cross-browser E2E** — LambdaTest integration for Playwright suites across 3000+ browser/OS combos
- **Synthetic monitoring** — Datadog API and browser synthetics with multi-region coverage
- **QA KPI dashboards** — Grafana dashboards tracking test pass rates, flakiness, and coverage trends

## Scaffold Templates

All templates are available in the Backstage **Create** page (`http://backstage.idp.local/create`) and via the CLI (`./scripts/create-test-suite.sh`).

### Functional & E2E

| Template | Tool | What it tests |
|----------|------|--------------|
| `playwright-e2e-suite` | Playwright | Full browser journeys with LambdaTest cloud option |
| `visual-regression-suite` | Playwright screenshots | Pixel-diff UI changes on every PR |
| `accessibility-suite` | axe-core + Playwright | WCAG 2.0/2.1 compliance (A / AA / AAA) |
| `bdd-cucumber-suite` | Cucumber.js | Gherkin scenarios for cross-team test ownership |
| `appium-mobile-suite` | Appium + WebdriverIO | iOS and Android mobile app journeys |

### API & Contract

| Template | Tool | What it tests |
|----------|------|--------------|
| `newman-api-suite` | Newman (Postman) | REST API collections with JUnit/HTML reporting |
| `pact-contract-suite` | Pact + PactFlow | Consumer-driven contract verification |

### Performance & Reliability

| Template | Tool | What it tests |
|----------|------|--------------|
| `k6-performance-suite` | k6 | Smoke / load / stress scenarios with Grafana push |
| `chaos-mesh-suite` | Chaos Mesh | Pod failure, network latency, CPU/memory stress |
| `testcontainers-suite` | Testcontainers | Integration tests against real DB/queue containers |

### Security & Quality

| Template | Tool | What it tests |
|----------|------|--------------|
| `zap-dast-suite` | OWASP ZAP | Dynamic security scanning (baseline / full / API) |
| `datadog-synthetic-suite` | Datadog Synthetics | API + browser synthetic monitors, multi-region |
| `mutation-testing-suite` | Stryker | Test suite quality — mutation score threshold |

### Brownfield & Coverage

| Template | Tool | What it tests |
|----------|------|--------------|
| `unit-test-suite` | Go / Vitest / pytest | Language-aware unit tests with 70% coverage gate and JUnit output |
| `component-test-suite` | WireMock + service-under-test | Single service in isolation with HTTP deps stubbed |
| `iac-test-suite` | tflint + Checkov + Terratest | Terraform lint, policy scan (SARIF), and optional real-apply tests |

### Mobile Testing

| Template | Tool | What it tests |
|----------|------|--------------|
| `flutter-integration-test-suite` | Flutter + Firebase TestLab | Flutter app integration tests on real devices or local emulator |
| `appium-mobile-suite` | Appium + WebdriverIO | iOS and Android end-to-end journeys (BrowserStack / Sauce Labs) |

---

## Mobile App Development

The platform provides a complete golden path for mobile apps. See the [Mobile Developer Guide](mobile-developer-guide.md) for detailed setup.

| Template | Purpose |
|---|---|
| `android-app` | Kotlin + Jetpack Compose golden-path app with Fastlane CI/CD |
| `ios-app` | Swift + SwiftUI golden-path app with Fastlane and SonarCloud |
| `flutter-app` | Dart multi-platform app (Android / iOS / Web) with optional K8s deploy |
| `mobile-sdk` | Shared SDK library for Android (Kotlin), iOS (SPM), Flutter, or KMP |
| `mobile-code-signing` | Automated code signing — Fastlane Match (S3) for iOS, keystore for Android |
| `mobile-app-store-deploy` | Automated Google Play / App Store release via Fastlane |
| `mobile-device-farm` | Firebase TestLab device-farm testing with low/medium/high device matrices |

## CLI Golden Path

```bash
# Scaffold a Playwright E2E suite
./scripts/create-test-suite.sh --name my-e2e --type playwright --service hello-service

# Scaffold a k6 performance suite with custom SLOs
./scripts/create-test-suite.sh --name perf-tests --type k6 --service hello-service \
  --vus 20 --duration 2m --p95 300

# Scaffold an accessibility suite enforcing WCAG 2.1 AA
./scripts/create-test-suite.sh --name a11y --type accessibility --service hello-service \
  --wcag wcag21aa

# All types: playwright | k6 | pact | newman | zap | datadog | visual |
#            accessibility | cucumber | appium | chaos | mutation | testcontainers |
#            unit | component | iac | flutter-integration
```

All scaffolded suites land in `test-suites/<name>/`, get a `catalog-info.yaml`, and are committed to git automatically.

## Owned Resources

| Resource | Purpose |
|---|---|
| SonarCloud | SAST & code-quality gate |
| LambdaTest | Cross-browser cloud testing grid |
| Mailtrap | Email sandbox for CI testing |
| Datadog | Synthetic monitoring (API + browser) |

## Links

- [QA Metrics Dashboard](http://grafana.idp.local/d/qa-metrics/qa-metrics)
- [Playwright E2E Reports](https://github.com/moatazeldebsy/backstage-platform-template/actions)
- [Datadog Synthetics](https://app.datadoghq.eu/synthetics)
