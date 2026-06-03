# Security

This page documents the security posture of the platform template — what has been hardened, where the remaining gaps are, and the rationale behind a few decisions that are not obvious from the code alone.

For vulnerability disclosure, see [`SECURITY.md`](https://github.com/moatazeldebsy/backstage-platform-template/blob/main/SECURITY.md) at the repo root.

## Dependency vulnerability remediation

In May 2026 a full Dependabot sweep flagged 91 alerts across the Backstage frontend/backend, MCP servers, and scaffolded service templates. The current state is **90 remediated, 2 dismissed (no upstream fix)**.

| Bucket | Result |
|---|---|
| Backstage core | Bumped to **v1.50.4** via `yarn backstage-cli versions:bump` — pulled patched versions of 104+ `@backstage/*` packages and their transitives |
| `@backstage/plugin-scaffolder-node` | Bumped `^0.9.0` → `^0.13.2` |
| Transitive npm deps | 27 `resolutions` pinned in `backstage/app/package.json` covering `axios`, `tar`, `undici`, `minimatch`, `protobufjs`, `jsonpath-plus`, `form-data`, `lodash`, `koa`, `dompurify`, `postcss`, `fast-uri`, `uuid`, `@octokit/*`, `qs`, `cookie`, `fast-xml-parser` (`^5.7.0`), `@tootallnate/once` (`^3.0.1`) |
| `vm2` | **Replaced with a local shim** (`backstage/app/vm2-shim/`) — see below |
| `services/idp-mcp-server` | `hono` → 4.12.19, `ip-address` → 10.2.0 |
| `react-frontend` scaffold skeleton | `vite` `^5.4.0` → `^6.4.2` |
| Dismissed | `elliptic` — no upstream fix available; `request` — deprecated and not exercised by our code paths |

The two commits implementing this are `5ff7971` (88 of 91) and `678d201` (final 2).

### Why `vm2` was replaced rather than upgraded

`vm2` was reached transitively via `typescript-json-schema` ← `@backstage/config-loader`. Upstream `vm2` was abandoned with no plan to ship a fix for the known sandbox-escape CVEs. The shim at `backstage/app/vm2-shim/index.js` is a ~30-line wrapper around Node's built-in `vm` module that exposes the same surface (`VM`, `NodeVM`) used by `typescript-json-schema`. It is copied into the Backstage image **before** `yarn workspaces focus` runs (see `backstage/Dockerfile`, commit `b98c924`), so the focus step resolves the shim instead of trying to download the abandoned package.

## Dependabot policy

Automated version-update PRs are **disabled** in `.github/dependabot.yml` (`open-pull-requests-limit: 0` for the npm and Docker ecosystems). Security alerts still surface.

The reason is incident-driven: two auto-bump PRs broke the working configuration in successive weeks —

1. `uuid` v9 → v10 silently dropped its default export, crashing every Backstage page that rendered a `@material-table/core` table.
2. `@backstage/plugin-scaffolder-node` moved an extension-point export from the main entry to `/alpha`, which caused our custom scaffold actions to crash at startup and left the catalog refresh loop stuck with 0 entities.

Both required manual intervention (a yarn patch and an import-path revert). Until we have a CI signal that can catch these *before* the PR is merged, version-update PRs are off and dependency upgrades happen as scoped, reviewed batches.

## Crossplane IAM: least-privilege provider roles

The Crossplane IRSA role (`terraform/iam-crossplane.tf`) was previously
attached to five AWS-managed `*FullAccess` policies. These have been replaced
with **scoped inline policies** — one per resource family:

| Policy | Scope |
|---|---|
| `crossplane_s3` | Bucket create/delete/configure — restricted to `arn:aws:s3:::idp-*` |
| `crossplane_rds` | Instance + subnet-group lifecycle — restricted to `arn:aws:rds:*:*:db:idp-*` |
| `crossplane_kafka` | Topic lifecycle on `arn:aws:kafka:*:*:cluster/idp-*/*` |
| `crossplane_dynamodb` | Table lifecycle — restricted to `arn:aws:dynamodb:*:*:table/idp-*` |
| `crossplane_sqs` | Queue lifecycle — restricted to `arn:aws:sqs:*:*:idp-*` |
| `crossplane_tagging` | `tag:*` on `*` (required by the Resource Groups Tagging API) |

The `idp-*` prefix constraint aligns with the `pattern` validations in each XRD, so a Claim can never request a resource name that falls outside the policy scope.

## Crossplane data-safety defaults

All five Compositions (`aws/crossplane/compositions/*/composition.yaml`) ship
with these safety defaults:

- **`deletionPolicy: Orphan`** — deleting a Claim never deletes the underlying
  AWS resource. Accidental `kubectl delete` cannot cause data loss. Full
  decommission requires an explicit manual step.
- **`skipFinalSnapshot: false`** (RDS) — a final snapshot is created before any
  RDS instance is deleted, even when triggered by `cleanup.sh`.
- **`backupRetentionDays: 30`** (RDS, configurable) — automated backups kept
  for 30 days by default.
- **`storageEncrypted: true`** (RDS) and **`sqsManagedSseEnabled: true`** (SQS)
  — encryption at rest is non-optional.

## Container & supply-chain hardening

- Backstage `Dockerfile` runs as non-root, uses a distroless-style runtime stage, and pins all base-image digests.
- GitHub Actions CI uses `aws-actions/configure-aws-credentials` with OIDC — no long-lived AWS keys in repo secrets.
- Trivy scans every image build; Cosign signs images pushed to ECR/GHCR.
- OPA/Gatekeeper policies in `kubernetes/opa-policies/` reject pods that pull `:latest`, lack resource limits, or omit cost-allocation labels.
- RDS security group restricts ingress to the VPC CIDR (no `0.0.0.0/0`).
- All namespaces enforce Pod Security Standards (`restricted` where possible, `baseline` for system namespaces).

## Production Backstage Hardening

The following hardening steps were applied to the AWS Backstage deployment in commit `e4e00dc`:

### Authentication

- **Guest auth removed** — the `dangerouslyAllowOutsideDevelopment` guest provider is no longer present in `backstage/app-config.aws.yaml`. Production requires GitHub OAuth (`auth.providers.github`).
- **Session secret from Secrets Manager** — `AUTH_SESSION_SECRET` is injected at pod startup via the External Secrets Operator; there is no static fallback value in the config file.

### Database

- **TLS cert validation enabled** — `rejectUnauthorized: true` is set for the PostgreSQL connection in `kubernetes/backstage/configmap.yaml`. The cluster CA is mounted from a Kubernetes secret.

### Infrastructure

- **No hardcoded AWS Account ID** — `aws/backstage/deployment.yaml` uses `${AWS_ACCOUNT_ID}` and `${AWS_REGION}` environment variable placeholders substituted at deploy time by `bootstrap.sh`, rather than the literal account ID.

These settings are in effect only in the AWS config. Local Kind development still uses guest auth and skips TLS (see Local-only relaxations below).

## Local-only relaxations

These exist to make the developer-loop experience usable on Kind/Rancher Desktop and **must not** be ported to a production cluster:

- `app-config.local.yaml`: `backend.auth.dangerouslyDisableDefaultAuthPolicy: true` — prevents a 401 flash before guest sign-in completes (Backstage v1.29+).
- `kubernetes/kagent/ingress*.yaml`: plain HTTP with `ssl-redirect: "false"`.
- Local registry `localhost:5003` is HTTP and unauthenticated.

The [readiness checklist](readiness-checklist.md) calls these out before promoting to a real environment.

## Reporting

See [`SECURITY.md`](https://github.com/moatazeldebsy/backstage-platform-template/blob/main/SECURITY.md) for the private-disclosure process.
