# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added
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
