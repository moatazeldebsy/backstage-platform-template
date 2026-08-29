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
- [Multi-Region (V2)](multi-region.md) — Active-standby AWS across eu-central-1 + us-east-1, opt-in
- [Mobile Platform](mobile-platform.md) — 7 mobile golden-path templates (Android, iOS, Flutter, SDK, code signing, app store, device farm)
- [Crossplane](crossplane.md) — Self-serve per-service AWS resources via in-cluster Claims
- [Crossplane vs Terraform](crossplane-vs-terraform.md) — Which tool owns what, and why
- [CLI Reference](cli-reference.md) — `idp` CLI commands, flags, and all 18 test-suite types
- [Scripts Reference](scripts-reference.md) — Every `scripts/*.sh` script, grouped by day-0/1/2

### Team Management
- [Team Management](team-management.md) — Onboard a team: namespace, SecretStore, ArgoCD ApplicationSet, Grafana folder, DORA metrics
- [GitHub App Setup](github-app-setup.md) — Replace PAT with GitHub App for higher rate limits and per-installation scoping
- [Scaling Runbook](scaling-runbook.md) — Small/Medium/Large tiers, scaling signals, implementation status

### Engineering Intelligence
- [Product Vision](engineering-intelligence/product-vision.md) — What the intelligence layer answers, and for whom
- [Architecture](engineering-intelligence/architecture.md) — How it is built, and an honest inventory of which data actually exists
- [Maturity Model](engineering-intelligence/maturity-model.md) — Ad Hoc → Standardised → Platform Enabled → AI Enabled → Autonomous
- [Scoring](engineering-intelligence/scoring.md) — The evidence contract: no score without evidence, no number without data
- [Integrations](engineering-intelligence/integrations.md) — Every collector, its source, and what happens when that source is down
- [AI Advisor](engineering-intelligence/ai-advisor.md) — What it may say, what it refuses to say, and why
- [Roadmap](engineering-intelligence/roadmap.md) — The thirteen phases and the data blocker on each

### Advanced Topics
- [Contract Testing](contract-testing.md) — Self-describing, self-testing APIs with MCP
- [AI Assistant](ai-assistant.md) — KAgent AI agents embedded in Backstage
- [Agentic Development Platform (ADP)](agentic-platform.md) — Agent-driven dev workflow + ops, HiTL approval gate, opt-in via `bootstrap-ai.sh --adp`
- [Agent Approvals](agent-approvals.md) — Human-in-the-loop gate for agent-initiated mutating actions: policy, approval API, Backstage UI
- [DORA & FinOps](dora-finops.md) — DORA entity tab (Elite/High/Medium/Low badges) + FinOps cost overview with team dimension in Backstage
- [Security](security.md) — Pod Security Standards, OPA/Gatekeeper, RBAC, per-team secret isolation, production hardening
- [Flaky-Test Quarantine](flaky-test-quarantine.md) — How flaky tests get detected (exporter) and acted on (auto quarantine PRs)
- [Test-Impact Analysis](test-impact-analysis.md) — Selective test execution on PRs via pytest-testmon (python-service golden path)

### Operations
- [Troubleshooting](TROUBLESHOOTING.md) — **Start here when something is broken.** Symptom-indexed fixes
- [SRE & Reliability](sre-reliability.md) — SLOs, burn-rate alerts, PodDisruptionBudgets, rollback, DR failover
- [Production Readiness](readiness-checklist.md) — Pre-production checklist
- [AWS Install Failure Modes](aws-install-failure-modes.md) — What breaks during an EKS bootstrap, and why
- [Docker Recovery](docker-recovery.md) — Recover Kind cluster after Docker Desktop restarts
- [Security Scanning](security-scanning.md) — gitleaks, CodeQL, Trivy, Snyk and how findings are triaged
- [Postmortem Template](postmortem-template.md) — Blameless incident write-up scaffold
- [Runbooks](runbooks/index.md) — Operational procedures and on-call guides

### Shift-Left Programme
- [Shift-Left Quality](shift-left.md) — How the platform embeds testing at scaffold, PR, deploy, and runtime
- [Pilot Kickoff](shift-left-pilot-kickoff.md) — Running the programme with a first team
- [Leadership Brief](shift-left-leadership.md) — The case, the metrics, and what to expect
- [Demo Cheatsheet](shift-left-demo-cheatsheet.md) — Short script for demoing the quality story
- [Demo Runbook](demo-runbook.md) — Full end-to-end platform demo walkthrough

### Reference
- [Roadmap](https://github.com/users/moatazeldebsy/projects/5) — Upcoming features and milestones, tracked as GitHub Project issues
- [Architecture](architecture.md) — System design and data flow
