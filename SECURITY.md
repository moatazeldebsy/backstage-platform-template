# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| `main` branch | ✅ Active |
| Tagged releases (latest) | ✅ Active |
| Older tagged releases | ❌ No backports |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Report vulnerabilities privately via one of these channels:

1. **GitHub Private Advisory** (preferred) — open a
   [Security Advisory](../../security/advisories/new) directly on this repository.
2. **Email** — send details to `security@idp.platform` with subject line
   `[backstage-platform-template] <short description>`.

### What to include

- A description of the vulnerability and its potential impact
- Steps to reproduce (proof-of-concept or exploit code if available)
- Affected versions or components
- Any suggested mitigations

### Response SLA

| Stage | Target |
|-------|--------|
| Acknowledgement | Within 48 hours |
| Initial assessment | Within 5 business days |
| Patch or mitigation | Within 30 days for Critical/High; 90 days for Medium/Low |
| Public disclosure | Coordinated with the reporter after patch is available |

## Disclosure Policy

We follow coordinated disclosure. Once a fix is available we will:

1. Publish a patched release
2. Create a GitHub Security Advisory with full details
3. Credit the reporter (unless anonymity is requested)

## Security Hardening in This Project

This template ships with these security controls enabled by default:

| Control | Implementation |
|---------|---------------|
| OPA/Gatekeeper policies | Deny `:latest` tags, require health probes, resource limits, and cost labels |
| OIDC keyless auth | GitHub Actions → AWS via `aws-actions/configure-aws-credentials` — no long-lived secrets |
| Pod Security Standards | `baseline` enforced on all service namespaces |
| Image scanning | Trivy scan on every build (Phase 5 roadmap item) |
| Image signing | Cosign signing after ECR push (Phase 5 roadmap item) |
| Secrets management | AWS Secrets Manager + External Secrets Operator; no secrets in Git |

## Known Accepted Risks

| Dependency | Alerts | Reason | Re-evaluate when |
|---|---|---|---|
| `react-router` / `react-router-dom` (`backstage/app`) | GHSA-wrjc-x8rr-h8h6, GHSA-337j-9hxr-rhxg, and the unpatched react-router-dom open-redirect advisory | Fix requires react-router **v7**, but the latest published `@backstage/frontend-defaults` and `@backstage/core-app-api` (as of 2026-07) still hard-pin `react-router-dom: ^6.30.2` as a peer dependency — Backstage hasn't shipped v7 support. Bumping independently breaks the frontend. | Backstage's frontend packages drop the react-router v6 peer dependency pin. |

Dismissed on GitHub (Dependabot alerts #230, #233, #234, #235, #236) with reason
`tolerable_risk` — see each alert's dismissal comment for the same rationale.

## Scope

This policy covers the platform template itself. Services scaffolded from the
templates are the responsibility of their respective owners, though the templates
embed security best practices by default.
