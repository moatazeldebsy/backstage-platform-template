# Security Scanning — SonarCloud + Snyk

This page covers the platform's two managed code-quality / SCA integrations:

| Tool | What it does | Where results show up |
|---|---|---|
| **SonarCloud** | Code quality, coverage, maintainability, security hotspots, **quality gate** | GitHub Actions check + Security entity tab + shift-left scorecard |
| **Snyk** | Dependency (SCA) + container + IaC vulnerability scanning | GitHub Actions check + Security entity tab + shift-left scorecard |

Both integrations are **opt-in but free to wire**: the CI workflow steps and proxy
endpoints are pre-configured and skip silently when tokens aren't set. Adding the
tokens "turns them on" — no further code changes required.

## How it fits in the shift-left programme

Two new scorecard checks are added to the existing tier model in
[`shift-left.md`](shift-left.md):

| Check | Group | What it means |
|---|---|---|
| `has-sonar-scanning` | Security | Service has `sonarcloud.io/project-key` annotation OR `sonar-scanning` in `idp.io/quality-gates` |
| `has-snyk-scanning`  | Security | Service has `snyk.io/org-slug` annotation OR `snyk-scanning` in `idp.io/quality-gates` |

These count toward Silver / Gold tier alongside the existing coverage, static-analysis,
vuln-scan, contract, and e2e checks.

## One-time setup

### 1. Create SonarCloud organization

1. Sign in at <https://sonarcloud.io> with your GitHub account.
2. Click **+ → Analyze new project** and select your GitHub org.
3. SonarCloud will create an **organization** matching your GitHub org slug.
4. Project keys default to `<org>_<repo>` — the platform's scaffolders use the same
   convention so no manual configuration is needed.

### 2. Generate a SonarCloud token (for Backstage)

1. <https://sonarcloud.io/account/security>
2. **Generate a User Token** named e.g. `backstage-idp-readonly`.
3. Copy the token — you won't see it again.

### 3. Create Snyk organization

1. Sign in at <https://app.snyk.io>. The free **Open Source** plan covers SCA.
2. **Settings → General** → note your org slug (used as `snyk.io/org-slug` annotation).
3. Optional: **Integrations → GitHub** → connect the GitHub org so `snyk monitor`
   can populate projects automatically.

### 4. Generate a Snyk token (for Backstage and CI)

1. <https://app.snyk.io/account> → **Auth Token** → reveal and copy.

### 5. Store tokens

**Local (Backstage proxy + Security tab):**

Add to `local/backstage/.env` (gitignored):

```bash
SONAR_TOKEN=<your-sonarcloud-token>
SNYK_TOKEN=<your-snyk-token>
```

Restart Backstage:

```bash
docker compose -f local/backstage/docker-compose.yml restart backstage
```

**AWS (production):**

Add the two tokens to AWS Secrets Manager (the existing `backstage-secrets` secret)
and ensure they're projected into the Backstage pod via External Secrets. See
`aws/external-secrets/backstage.yaml`.

**GitHub Actions (for CI):**

Set as **organization-level secrets** so every scaffolded service inherits them
without per-repo configuration:

```
GitHub org → Settings → Secrets and variables → Actions → New organization secret
  SONAR_TOKEN  →  Repository access: All repositories (or selected)
  SNYK_TOKEN   →  Repository access: All repositories (or selected)
```

Until both org-level secrets exist, the Sonar + Snyk CI steps **skip** (not fail) —
so newly scaffolded services build green out of the box.

## Two usage paths

### Path A — new services (automatic)

Every service scaffolded via `go-service`, `nodejs-service`, or `python-service`
ships with:

- A `quality` CI job that runs SonarCloud and Snyk, gated on token presence
- A `sonar-project.properties` at the repo root with `<org>_<repo>` as the project key
- A `.snyk` policy file (empty `ignore:` block — add CVE waivers here when needed)
- `catalog-info.yaml` annotations: `sonarcloud.io/project-key`, `sonarcloud.io/organization`, `snyk.io/org-slug`, and the `sonar-scanning,snyk-scanning` entries in `idp.io/quality-gates`

When the org-level tokens exist, the first push triggers a full scan.

### Path B — existing services (brownfield)

Run the **Enable Security Scanning (SonarCloud + Snyk)** template from the Backstage
scaffolder. It opens a PR against the target repo adding:

- `.github/workflows/security-scanning.yml` — standalone workflow (independent of the service's main `ci.yml`)
- `sonar-project.properties`
- `.snyk`

After merging, update the service's `catalog-info.yaml` to add the
`sonarcloud.io/project-key` and `snyk.io/org-slug` annotations so the Security
entity tab can fetch data and the scorecard checks light up.

## Where results show up

### GitHub Actions

The `quality` job in CI (or the standalone `security-scanning` workflow for brownfield
adopters) shows two check runs per PR:

- **SonarCloud quality gate** — fails the build when the quality gate is RED
- **Snyk dependency scan** — fails the build at the configured severity threshold (default `high`)

### Backstage — Security entity tab

Every Component entity gets a new **Security** tab (`/security`) that:

- Reads the `sonarcloud.io/project-key` annotation and fetches the live quality
  gate + coverage / bugs / vulnerabilities / hotspots / code-smells via the
  `/api/proxy/sonarcloud` proxy.
- Reads the `snyk.io/org-slug` annotation and renders a card linking to the
  project in Snyk's dashboard.
- Renders a "not configured" empty state with a one-click link to the
  Enable Security Scanning template when annotations are missing.

### Backstage — Shift-Left Scorecard tab

The existing **Scorecard** tab gets two new checks under a **Security** group:
`SonarCloud quality gate` and `Snyk SCA scan`. Both contribute to the entity's
Bronze / Silver / Gold tier.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| CI step shows "skipped" | `SONAR_TOKEN` / `SNYK_TOKEN` not set at the org level | Add as org-level secrets (see "Store tokens" above) |
| Security tab shows 401 | Backstage proxy can reach SonarCloud but auth failed | Verify token in `local/backstage/.env` is valid; restart container |
| Security tab shows "not configured" | Entity is missing both annotations | Add `sonarcloud.io/project-key` and/or `snyk.io/org-slug` to `catalog-info.yaml` |
| Sonar gate is `ERROR` and CI fails | New project, no baseline yet | Lower the quality gate's "new code" thresholds in SonarCloud UI, or push first scan before enforcing |
| Snyk reports vulns that have no fix | False positive or unfixable transitive | Add a YAML block to `.snyk` under `ignore:` with an expiry date |
| Scorecard checks stay red even though scans run | TechInsights cache | Wait up to 30 min (cadence) or restart Backstage; the retriever re-runs on startup |

## Reference

- SonarCloud API docs: <https://sonarcloud.io/web_api>
- Snyk API docs: <https://docs.snyk.io/snyk-api>
- Platform fact retriever: `backstage/app/packages/backend/src/modules/idpTechInsights.ts`
- Security tab UI: `backstage/app/packages/app/src/extensions.tsx` (`SecurityEntityContent`)
- Brownfield template: `backstage/catalog/templates/enable-security-scanning/`
