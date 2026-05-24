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
- [Crossplane](crossplane.md) — Self-serve per-service AWS resources via in-cluster Claims
- [Crossplane vs Terraform](crossplane-vs-terraform.md) — Which tool owns what, and why
- [Shift-Left Quality](shift-left.md) — How the platform embeds testing at scaffold, PR, deploy, and runtime

### Advanced Topics
- [Contract Testing](contract-testing.md) — Self-describing, self-testing APIs with MCP
- [AI Assistant](ai-assistant.md) — KAgent AI agents embedded in Backstage
- [Security](security.md) — Pod Security Standards, OPA/Gatekeeper, RBAC

### Operations
- [Improvements Summary](IMPROVEMENTS_SUMMARY.md) — Critical fixes, AI/ML enhancements, cost savings analysis (read first after your first AWS deployment)
- [Production Readiness](readiness-checklist.md) — Pre-production checklist
- [Runbooks](runbooks/index.md) — Operational procedures and on-call guides

### Reference
- [Roadmap](roadmap.md) — Upcoming features and milestones
- [Architecture](architecture.md) — System design and data flow
