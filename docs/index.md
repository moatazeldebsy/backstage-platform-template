# Internal Developer Platform

A golden-path platform for building, deploying and operating services on Kubernetes.
Backstage is the front door. ArgoCD, Crossplane, Prometheus, OPA/Gatekeeper and an
opt-in AI layer do the work behind it, the same way on a laptop (Kind) as on AWS (EKS).

**New here?** Start with the [Quickstart](getting-started.md). It takes 15–20 minutes
locally and needs no cloud account.

![Platform planes](assets/platform-planes.png)

## Explore the docs

<div class="grid cards" markdown>

-   **Get Started**

    ---

    [Quickstart](getting-started.md): bring it up and ship a first service

    [Local Setup](local-setup.md): the full platform on your laptop with Kind

    [Screenshots](screenshots.md): a tour of the portal

-   **Deploy on AWS**

    ---

    [Pre-Deployment Checklist](PRE_DEPLOYMENT_CHECKLIST.md): **read this first**, verify every key and credential

    [Deployment Guide](DEPLOYMENT_GUIDE.md): EKS walkthrough, known issues, cost

    [Known Failure Modes](aws-install-failure-modes.md): what breaks during an EKS bootstrap, and why

    [Readiness Checklist](readiness-checklist.md) · [GitHub App Setup](github-app-setup.md)

-   **Platform**

    ---

    [Golden Path](golden-path.md): conventions every service follows

    [Mobile Platform](mobile-platform.md): 7 mobile golden-path templates

    [PR Preview Environments](preview-environments.md) · [Contract Testing](contract-testing.md)

    [Crossplane](crossplane.md) · [Crossplane vs Terraform](crossplane-vs-terraform.md)

    [Team Management](team-management.md) · [DORA & FinOps](dora-finops.md)

-   **AI & Agents**

    ---

    [AI Assistant](ai-assistant.md): KAgent agents embedded in Backstage

    [Agentic Development Platform](agentic-platform.md): agent-driven dev workflow and ops, opt-in via `bootstrap-ai.sh --adp`

    [Agent Approvals](agent-approvals.md): human-in-the-loop gate for mutating agent actions

-   **Engineering Intelligence**

    ---

    [Product Vision](engineering-intelligence/product-vision.md) · [Architecture](engineering-intelligence/architecture.md)

    [Maturity Model](engineering-intelligence/maturity-model.md) · [Scoring](engineering-intelligence/scoring.md)

    [Integrations](engineering-intelligence/integrations.md) · [AI Advisor](engineering-intelligence/ai-advisor.md)

    [Roadmap](engineering-intelligence/roadmap.md)

-   **Quality & Security**

    ---

    [Shift-Left Quality](shift-left.md): testing at scaffold, PR, deploy and runtime

    [Flaky-Test Quarantine](flaky-test-quarantine.md) · [Test-Impact Analysis](test-impact-analysis.md)

    [Security](security.md) · [Security Scanning](security-scanning.md)

-   **Operate**

    ---

    [Troubleshooting](TROUBLESHOOTING.md): **start here when something is broken**

    [SRE & Reliability](sre-reliability.md): SLOs, burn-rate alerts, PDBs, rollback

    [Runbooks](runbooks/index.md) · [Scaling Runbook](scaling-runbook.md)

    [Docker Recovery](docker-recovery.md) · [Post-Mortem Template](postmortem-template.md)

-   **Reference**

    ---

    [Architecture](architecture.md): system design and data flow

    [CLI Reference](cli-reference.md): `idp` commands and flags

    [Scripts Reference](scripts-reference.md): every `scripts/*.sh`, grouped into day-0, day-1 and day-2

    [Design Decisions](design/adr-0001-batch-orchestration.md): ADR-0001 to ADR-0009

    [Roadmap](https://github.com/users/moatazeldebsy/projects/5): tracked as GitHub issues

</div>
