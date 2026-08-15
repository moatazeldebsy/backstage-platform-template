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
| `react-router` / `react-router-dom` (`backstage/app`) | GHSA-wrjc-x8rr-h8h6, GHSA-337j-9hxr-rhxg, and the unpatched react-router-dom open-redirect advisory | Fix requires react-router **v7**, but the latest published `@backstage/frontend-defaults` and `@backstage/core-app-api` (re-verified 2026-08-04) still hard-pin `react-router-dom: ^6.30.2` as a peer dependency — Backstage hasn't shipped v7 support. Bumping independently is also **inert**: the root `backstage/app/package.json` pins `react-router: ^6.30.4` under `resolutions`, so a bumped dependency declaration resolves straight back to 6.x — verified by editing `packages/app/package.json` to `^8.3.0`, running a real `yarn install`, and finding **0** lockfile entries for react-router 8. `react-router-dom` is likewise unaffected, since it hard-depends on `react-router@6.x`. Dependabot is configured to `ignore` both packages for `/backstage/app` (`open-pull-requests-limit: 0` does not suppress *security* PRs). | Backstage's frontend packages drop the react-router v6 peer dependency pin — still present in the latest published `core-app-api` 1.20.3, `frontend-defaults` 0.5.4 and `core-plugin-api` 1.12.8 as of 2026-08-04. Then remove the `resolutions` pin and the Dependabot ignore together. |

| `extract-zip` (`backstage/catalog/templates/appium-mobile-suite/skeleton`) | GHSA-jmr9-qjv8-65gv (high) — unvalidated symlink path traversal. Inflates to 13 `npm audit` findings, but there is exactly one root cause | **No patched version exists.** The advisory range is `extract-zip *` and 2.0.1 (published 2020) is the newest release, so there is nothing to bump to. Reached only as `@wdio/utils → @puppeteer/browsers → extract-zip`, a `dev`-only path used to unpack a downloaded browser — an Appium mobile suite never triggers that download. npm's offered fix is `@wdio/cli@8.14.6`, a 2023 release that avoids the advisory only by predating the `@puppeteer/browsers` dependency; taking it would downgrade the whole WebdriverIO stack from v9. | `extract-zip` publishes a fix, or `@puppeteer/browsers` drops it (it is used for one unzip call). Re-check with `npm audit --package-lock-only` in that skeleton. |

| `cryptography` (`backstage/catalog/templates/mlflow-experiment/skeleton`) | CVE-2026-69247 (via `mlflow`) | Transitive only. `mlflow` caps `cryptography<50`, so pinning `cryptography>=50.0.0` does not upgrade it — pip instead resolves **backwards** to `mlflow 3.2.0` and `pyarrow 21.0.0`, taking the count from **1 vulnerability to 27**. Measured, not assumed. Leaving the requirement open keeps mlflow at 3.15.1 with a single known issue. | `mlflow` relaxes its `cryptography<50` cap. Re-check with `pip-audit -r requirements.txt` on a rendered skeleton. |

Dismissed on GitHub (Dependabot alerts #230, #233, #234, #235, #236) with reason
`tolerable_risk` — see each alert's dismissal comment for the same rationale.

**Not everything in the react-router family is blocked on v7.** `@remix-run/router`
is a separate package, and GHSA-2j2x-hqr9-3h42 against it was fixed in 1.23.3 —
which `react-router@6.30.4` already depends on. Only `react-router-dom@6.30.2`
still pinned the vulnerable 1.23.2, so a single `@remix-run/router: ^1.23.3`
entry under `resolutions` deduped both consumers onto the patched version with no
v7 migration involved. Check whether an advisory names react-router itself before
assuming the row above covers it.

**Never run `npm audit fix --force` in the scaffold skeletons.** For the test-suite
templates npm's "fixes" are major *downgrades* to versions that merely predate the
advisories — `appium@^3.6.0 → 1.22.3`, `newman@^6.2.2 → 2.1.2`,
`@wdio/mocha-framework@^9.30.1 → 7.7.3`. Bump the direct dependency forward instead,
and check `engines.node` against the `node-version` pinned in that skeleton's workflow.

**An `overrides` block only takes effect if the lockfile was resolved with it present.**
The appium skeleton carried `brace-expansion: 5.0.9` under `overrides` while its
committed lockfile still pinned a nested `appium-uiautomator2-driver/node_modules/
brace-expansion@5.0.8`, and this file previously recorded that as unfixable — npm
"will not apply the override to that nested instance". That conclusion was wrong
because both commands used to test it (`npm install --package-lock-only` and a full
`npm install`) reuse already-resolved entries and never revisit them. Deleting
`package-lock.json` and regenerating forces re-resolution, and the override then
applies everywhere. When an override looks inert, delete the lockfile before
concluding npm is at fault — and check `packages[""].overrides` in the regenerated
lockfile to confirm it was actually recorded.

## Scope

This policy covers the platform template itself. Services scaffolded from the
templates are the responsibility of their respective owners, though the templates
embed security best practices by default.
