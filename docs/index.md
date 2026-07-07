# Internal Developer Platform

Welcome to the IDP MVP documentation. Use the navigation above to explore the platform.

## Quick Links

### Getting Started
- [Getting Started](getting-started.md) — 5-minute quickstart for local or AWS
- [Local Setup](local-setup.md) — Run the full platform on your laptop with Kind
- [Pre-Deployment Secrets Verification](PRE_DEPLOYMENT_CHECKLIST.md) — **Read this first!** Verify all API keys and credentials before AWS deployment
- [AWS Deployment Guide](DEPLOYMENT_GUIDE.md) — Complete AWS EKS deployment with pre-flight checklist, known issues, and troubleshooting

### Core Concepts
- [Golden Path](golden-path.md) — Conventions every service must follow
- [Mobile Platform](mobile-platform.md) — 7 mobile golden-path templates (Android, iOS, Flutter, SDK, code signing, app store, device farm)
- [Crossplane](crossplane.md) — Self-serve per-service AWS resources via in-cluster Claims
- [Crossplane vs Terraform](crossplane-vs-terraform.md) — Which tool owns what, and why
- [Shift-Left Quality](shift-left.md) — How the platform embeds testing at scaffold, PR, deploy, and runtime

### Team Management
- [Team Management](team-management.md) — Onboard a team: namespace, SecretStore, ArgoCD ApplicationSet, Grafana folder, DORA metrics
- [GitHub App Setup](github-app-setup.md) — Replace PAT with GitHub App for higher rate limits and per-installation scoping
- [Scaling Runbook](scaling-runbook.md) — Small/Medium/Large tiers, scaling signals, implementation status

### Advanced Topics
- [Contract Testing](contract-testing.md) — Self-describing, self-testing APIs with MCP
- [AI Assistant](ai-assistant.md) — KAgent AI agents embedded in Backstage
- [DORA & FinOps](dora-finops.md) — DORA entity tab (Elite/High/Medium/Low badges) + FinOps cost overview with team dimension in Backstage
- [Security](security.md) — Pod Security Standards, OPA/Gatekeeper, RBAC, per-team secret isolation, production hardening
- [Flaky-Test Quarantine](flaky-test-quarantine.md) — How flaky tests get detected (exporter) and acted on (auto quarantine PRs)
- [Test-Impact Analysis](test-impact-analysis.md) — Selective test execution on PRs via pytest-testmon (python-service golden path)

### Operations
- [Improvements Summary](IMPROVEMENTS_SUMMARY.md) — Critical fixes, AI/ML enhancements, cost savings analysis (read first after your first AWS deployment)
- [Production Readiness](readiness-checklist.md) — Pre-production checklist
- [Docker Recovery](docker-recovery.md) — Recover Kind cluster after Docker Desktop restarts
- [Runbooks](runbooks/index.md) — Operational procedures and on-call guides

### Reference
- [Roadmap](roadmap.md) — Upcoming features and milestones
- [Architecture](architecture.md) — System design and data flow
