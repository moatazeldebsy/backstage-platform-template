# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added

#### Local ↔ AWS environment parity (gap-fix)
- `kubernetes/external-secrets/cluster-secret-store.yaml` — ClusterSecretStore backed by AWS Secrets Manager; required by all ExternalSecrets in the repo. ESO ServiceAccount is annotated with the Backstage IRSA role ARN at deploy time.
- `observability/prometheus-stack-values-aws.yaml` — kube-prometheus-stack Helm values for AWS (ALB ingress, gp2 storage, 15-day retention, CloudWatch datasource, Grafana IRSA annotation, all three dashboard ConfigMap providers).

### Fixed
- `scripts/bootstrap.sh`: replaced standalone Grafana install (Phase 4) with `kube-prometheus-stack` so AWS now has Prometheus + AlertManager + Grafana at parity with local.
- `scripts/bootstrap.sh`: added Prometheus Pushgateway Helm install (Phase 4a) — both `apply-catalog-exporter.sh` and `seed-qa-metrics.sh` now work on AWS.
- `scripts/bootstrap.sh`: added OpenCost Helm install (Phase 4b) via `opencost/opencost` chart — was previously only applying a namespace manifest.
- `scripts/bootstrap.sh`: added Phase 3.6a to create ClusterSecretStore and annotate the ESO ServiceAccount with the Backstage IRSA role ARN immediately after ESO Helm install.
- `scripts/bootstrap.sh`: added `require-cost-tags.yaml` to both OPA policy apply passes (Phase 3.8) — was missing from AWS but present in local bootstrap.
- `scripts/bootstrap.sh`: replaced two `sleep 30` waits in Phase 3.8 with `kubectl wait crd ... --for=condition=Established --timeout=120s` for all five Gatekeeper ConstraintTemplate CRDs.
- `scripts/bootstrap.sh`: added Phase 4.4 to deploy tech-insights-exporter CronJob (ConfigMap + CronJob) — was never deployed on AWS despite the manifest existing.
- `scripts/bootstrap-local.sh`: added Step 11 to deploy tech-insights-exporter CronJob — was never deployed locally despite the manifest existing.
- `scripts/apply-catalog-exporter.sh`: corrected Backstage in-cluster URL from `http://backstage.default.svc.cluster.local:7007` to `http://backstage.backstage.svc.cluster.local:7007` (Backstage Service lives in the `backstage` namespace, not `default`).

#### QA Platform — 13 golden-path testing scaffold templates
- `playwright-e2e-suite` — Playwright TypeScript E2E with LambdaTest cloud option and HTML report upload
- `k6-performance-suite` — k6 smoke/load/stress scenarios with configurable VUs, duration, p95 threshold, and Prometheus Pushgateway push
- `pact-contract-suite` — Pact consumer-driven contracts with PactFlow broker publishing and provider verification CI
- `newman-api-suite` — Postman/Newman API test collections with JUnit + HTMLextra reporting
- `zap-dast-suite` — OWASP ZAP dynamic security scanning (baseline / full / API modes) with weekly schedule and false-positive suppression
- `datadog-synthetic-suite` — Datadog API and browser synthetics via `@datadog/datadog-ci`, multi-region, live and paused test definitions
- `visual-regression-suite` — Playwright screenshot pixel-diff with configurable threshold; diff artifacts uploaded on failure
- `accessibility-suite` — axe-core + Playwright enforcing WCAG 2.0/2.1 A / AA / AAA
- `bdd-cucumber-suite` — Cucumber.js Gherkin feature files with TypeScript step definitions and JUnit reporting
- `appium-mobile-suite` — Appium 2 + WebdriverIO for iOS and Android with configurable platform
- `chaos-mesh-suite` — Chaos Mesh pod failure, network latency, CPU stress, and memory stress experiments; manual trigger + weekly schedule
- `mutation-testing-suite` — Stryker mutation testing with configurable score threshold, per-test coverage analysis, HTML + JSON reports; weekly CI schedule
- `testcontainers-suite` — Testcontainers integration tests spinning up real Postgres, Redis, Kafka, etc. in CI with no mocks

#### CLI golden path for QA
- `scripts/create-test-suite.sh` — Mirrors all 13 Backstage QA templates from the terminal; supports all type-specific flags (`--vus`, `--duration`, `--wcag`, `--scan-type`, `--score`, `--containers`, etc.); generates files in `test-suites/<name>/`, writes `catalog-info.yaml`, and commits to git

#### Documentation
- QA Platform TechDocs (`backstage/catalog/docs/index.md`) updated with full template table and CLI usage guide
- `README.md` updated: template count, Scripts Reference, Golden Path section
- `CLAUDE.md` updated: `create-test-suite.sh` added to day-2 commands

### Planned
- Phase 6: Multi-environment GitOps promotion (staging + prod ArgoCD app-of-apps)
- Phase 7: AI/ML templates (ai-agent-service, model-serving-api, ml-training-job, mlflow-experiment)
- Phase 8: DORA metrics Backstage homepage widget, platform CLI

---

## [0.1.0] — 2026-04-29

Initial open-source release of the backstage-idp-starter template.

### Added
- Backstage v1.49.1 developer portal with catalog, TechDocs, Kubernetes plugin
- 7 golden-path software templates: Node.js, Python, Go, React, Terraform, Deploy-to-Kind, Team namespace
- Custom scaffolder actions: `idp:deploy-local`, `idp:provision-secret`, `idp:set-repo-secrets`
- Tech Insights scorecard module (`idpTechInsights`) — Bronze/Silver/Gold maturity model
- Single Helm chart (`helm/service-template`) for all service workloads
- GitHub Actions CI/CD: multi-language test detection, ECR push via OIDC, Trivy scan, Cosign signing
- ArgoCD GitOps: app-of-apps pattern for local (Kind) and AWS (EKS)
- OPA/Gatekeeper admission policies: deny-latest-tag, require-health-probes, require-resource-limits, require-labels, require-cost-tags
- Prometheus + Grafana observability with DORA metrics exporter (CloudWatch + Pushgateway)
- SLO definitions (Sloth) for hello-service: 99.5% availability, p99 < 500ms
- Tech Insights scorecard exporter CronJob → Prometheus Pushgateway
- AWS FinOps: Cost Anomaly Detection, Budgets with Slack alerts via SNS + Lambda
- OpenCost in-cluster cost visibility
- Terraform modules: EKS, VPC, ECR, IAM (OIDC + IRSA), RDS, S3, Secrets Manager
- `./scripts/setup.sh` guided personalisation (placeholder substitution + bootstrap dispatch)
- `./scripts/bootstrap-local.sh` one-command local Kind cluster setup
- MkDocs documentation site deployed to GitHub Pages
- SECURITY.md vulnerability disclosure policy
- Dependabot config for GitHub Actions, npm, and Go dependencies

### Fixed
- `YOUR_DISPLAY_NAME` placeholder restored in catalog-info.yaml (was hardcoded)
- `YOUR_ORG`/`YOUR_REPO` documentation tokens now substituted by setup.sh
- build-and-deploy.yml: graceful skip when `AWS_ROLE_ARN` secret is not set

[Unreleased]: https://github.com/moatazeldebsy/backstage-idp-starter/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/moatazeldebsy/backstage-idp-starter/releases/tag/v0.1.0
