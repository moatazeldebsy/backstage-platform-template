# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

---

## [0.5.0] — 2026-06-16

### Added

#### V2 Multi-Region Architecture — now on `main` (opt-in)

Active-standby multi-region topology: **eu-central-1 (primary)** + **us-east-1 (standby)**.
Merged from `feat/v2-multi-region`. Single-region local (Kind) and single-region AWS deployments are fully unaffected — multi-region is opt-in via `./scripts/bootstrap-multiregion.sh`.

**Phase 1 — Foundation**
- `terraform/global/` — Route 53 hosted zones, Global Accelerator, CloudFront distribution, ECR replication, Transit Gateway, KMS multi-region CMKs, Secrets Manager CRR
- ArgoCD hub-spoke ApplicationSet matrix generator (eu-central-1 hub → both clusters)
- Route 53 latency-based routing + health-check failover

**Phase 2 — Data Replication**
- Aurora Global Database (primary writer eu-central-1, read replica us-east-1, RPO < 1 s)
- DynamoDB Global Tables V2 across both regions
- S3 CRR for all team buckets + S3 Multi-Region Access Points

**Phase 3 — Traffic & Resilience**
- AWS Global Accelerator in front of regional ALBs (sub-30 s failover, no DNS TTL lag)
- CloudFront distribution with WAF + Shield Advanced + origin failover
- Argo Rollouts progressive delivery: eu-central-1 → health gate → us-east-1 (sync-wave)
- DR runbook (`docs/runbooks/dr-region-failover.md`) — Aurora promote → Crossplane ProviderConfig flip → ArgoCD sync

**Phase 4 — Observability & Security**
- Thanos sidecar per Prometheus + S3 object storage + global Thanos Query layer
- Security Hub aggregator (eu-central-1 aggregates findings from us-east-1)
- GuardDuty enabled in both regions
- CloudTrail organization trail → S3 CRR for immutable audit logs
- Backstage multi-cluster Kubernetes plugin (both clusters in entity page)

**Phase 5 — Platform Wiring**
- Platform S3 buckets + Transit Gateway inter-region peering
- Failover IRSA roles + Crossplane ProviderConfig per region
- `scripts/bootstrap-multiregion.sh` — full multi-region setup script
- `scripts/setup-v2-multiregion.sh` — post-deploy failover wiring script

**Phase 6 — Karpenter + Backstage HA**
- Karpenter spot-aware node autoscaling (EC2NodeClass + NodePool per region)
- Backstage warm-standby DB wiring (Aurora Global read replica in us-east-1)

**New Crossplane XRDs**
- `XECRReplicationRule` / `ECRReplicationRule` — account-level ECR cross-region replication
- `XRoute53HealthCheck` / `Route53HealthCheck` — Route 53 health check + DNS failover record
- `XGlobalAcceleratorEndpointGroup` / `GlobalAcceleratorEndpointGroup` — GA endpoint group per region (supports `trafficDialPercentage: 0` for warm standby)

**Crossplane XRD extensions (existing XRDs)**
- `XS3Bucket` — added `crossRegionReplication`, `replicaRegion`, `multiRegionAccessPoint`
- `XRDSInstance` — added `globalDatabase`, `replicaRegion`, `globalWriteForwarding`
- `XDynamoTable` — added `globalTable`, `replicaRegions[]`
- `XKafkaTopic` — added `crossRegionReplication`, `replicaRegion`

**New Backstage V2 Templates**
- `aurora-global-cluster` — provision Aurora Global Database via Terraform PR
- `dynamodb-global-table` — provision DynamoDB Global Table via Crossplane claim
- `s3-multiregion-access-point` — provision S3 MRAP + CRR via Crossplane claim
- `eks-multi-region` — scaffold ArgoCD ApplicationSet for hub-spoke multi-region deployment

### Fixed

#### Security — Dependabot alerts (0 open)
- Resolved all 31 open Dependabot alerts via PRs #65–68, #59, #61–64, #72, #74:
  - Bumped `esbuild` ≥ 0.28.1 across all services (cost/idp/qa/contract/github/argocd/agent-event-router MCP servers and `backstage/app`)
  - Bumped `react-router` ≥ 6.30.4, `@grpc/grpc-js` ≥ 1.14.4, `shell-quote` ≥ 1.8.4, `hono` (idp/qa MCP servers)
  - Bumped transitive deps via yarn `resolutions` / npm `overrides`: `tar`, `form-data`, `protobufjs`, `dompurify`, `js-yaml`, `@babel/core`, `launch-editor`, `markdown-it`

#### Local bootstrap (`bootstrap-local.sh`)
- **Pushgateway admin wipe**: corrected HTTP method from `DELETE` to `PUT` — eliminates the spurious pod restart on every fresh install
- **QA metrics seed race condition**: added ingress readiness retry loop (15 × 2 s) after Pushgateway restart before calling `seed-qa-metrics.sh`
- **`monitoring` namespace PodSecurity**: changed `enforce` level from `baseline` to `privileged` — `prometheus-node-exporter` (requires `hostNetwork`/`hostPort`) and `promtail` (requires `hostPath`) were being blocked from re-creation under the previous policy

#### KAgent — contract-mcp-server RemoteMCPServer registration
- `scripts/bootstrap-ai.sh` now applies `kubernetes/kagent/contract-toolserver.yaml` on every install — fixes `idp-assistant` and `platform-assistant` agents reporting `Accepted: False` / `Ready: Unknown` because the `contract-mcp-server` RemoteMCPServer they reference was never registered

### Changed
- `README.md`, `docs/multi-region.md`, `docs/roadmap.md` — removed stale `feat/v2-multi-region` branch references; updated opt-in instructions to point to `bootstrap-multiregion.sh`

---

## [0.4.0] — 2026-06-05

### Added

#### Team isolation & multi-tenancy (scales to 25+ teams)
- **Per-team ArgoCD ApplicationSet** — each team namespace now scaffolds an `applicationset.yaml` that scans `teams/<teamName>/services/*`; isolated from the global `services/*` ApplicationSet to prevent cross-team sync interference. Path convention: legacy/platform services stay under `services/`, team-owned services go under `teams/<teamName>/services/`.
- **Per-team SecretStore** — `team-namespace` scaffold generates a namespace-scoped `SecretStore` + IRSA `ServiceAccount`; secrets are scoped to `/<teamName>/*` in AWS Secrets Manager. `terraform/iam-team-secret-store.tf` provisions per-team IAM roles.
- **Per-team Grafana folder** — scaffold creates a `monitoring`-namespace ConfigMap labeled `grafana_folder: "Team — <name>"`, picked up by the Grafana sidecar to provision an isolated dashboard folder per team.
- **services-dev / staging / prod ResourceQuota + LimitRange** — `kubernetes/namespaces/services-quota.yaml`; prevents runaway pods in shared namespaces before teams migrate to team-* namespaces.

#### Crossplane cost governance
- **Kyverno team label injection** — `kubernetes/policies/kyverno/crossplane-team-label-policy.yaml`: mutate policy auto-injects `idp:team` on all Crossplane claims in `team-*` namespaces; validate policy blocks claims with no `owner` or `costCenter`.
- **`team` field on all XRDs** — S3Bucket, RDSInstance, DynamoTable, SQSQueue, KafkaTopic XRDs and compositions updated to propagate `idp:team` AWS tag (Kafka uses K8s labels as MSK topics don't support AWS resource tags).
- **Kyverno install** — `bootstrap-local.sh` (Step 9b) and `bootstrap.sh` (Phase 3.8) now install Kyverno 3.2.7 and apply team policies automatically.

#### GitHub App (replaces GH_PAT)
- **`auto-merge-onboarding.yml`** — uses `actions/create-github-app-token@v2` to generate a short-lived token from `APP_ID` + `APP_PRIVATE_KEY` secrets; falls back to `GH_PAT` for backward compatibility.
- **`app-config.aws.yaml`** — added `integrations.github.apps` block; Backstage uses the App for all catalog fetching and scaffolding API calls (higher rate limits, no rotation needed).
- Works on personal GitHub accounts and organisations.

#### DORA metrics team dimension
- `dora-exporter.py` — all Prometheus metrics now carry a `team=` label; team derived from `TEAM_MAP` env var (JSON map) or `team:<name>` GitHub repo topic.
- CloudWatch dimensions include `{"Name": "Team", "Value": "<team>"}` on every metric.
- `aws/observability/dora/dora-cronjob.yaml` — `TEAM_MAP` wired from Secrets Manager (optional key).
- `local/observability/dora/dora-cronjob.yaml` — commented-out `TEAM_MAP` ConfigMap example.

#### Catalog consolidation
- `backstage/catalog/all-templates.yaml` — single Location file indexing all 49 templates by tier (blessed / advanced). `app-config.aws.yaml` reduced from 49 URL entries to 1. Adding a template now requires one line in `all-templates.yaml` only.

#### Template versioning & curation
- All 50 `template.yaml` files tagged `v1`. Core service + platform templates tagged `blessed`; everything else tagged `advanced`. Teams can filter in Backstage by tier.

#### Backstage permission framework
- `app-config.aws.yaml` — `permission.enabled: true` added with inline scaffold instructions for the backend policy plugin (blocks unauthenticated scaffolder access by default).

### Changed
- `bootstrap-local.sh` and `bootstrap.sh` — apply `kubernetes/namespaces/services-quota.yaml` during Phase 3 / Step 3.
- `bootstrap.sh` Phase 3.7 — Secrets Manager population now includes `GITHUB_APP_*` and `TEAM_MAP` keys.
- `terraform/terraform.tfvars.example` — documents the new `team_eso_roles` variable.
- `local/.env.example` and `local/backstage/.env.example` — document GitHub App credentials and `TEAM_MAP`.
- Global ApplicationSets (`aws/argocd/app-of-apps.yaml`, `local/argocd/app-of-apps-local.yaml`) — added path convention comments to prevent team dirs being accidentally scanned.
- `observability/grafana/grafana-helm-values.yaml` — sidecar enabled (`searchNamespace: ALL`, `folderAnnotation: grafana_folder`).

---

## [0.3.0] — 2026-06-03

### Added

#### Mobile golden-path platform (7 templates + testing + scorecard)
- **`android-app`** — Kotlin + Jetpack Compose golden-path template; GitHub Actions CI (lint → test → build APK); Fastlane `Fastfile` (`test`, `build_debug`, `build_release`, `distribute`); SonarCloud + Snyk; configurable `minSdkVersion`; optional Firebase Crashlytics.
- **`ios-app`** — Swift + SwiftUI golden-path template; Xcode CI (SwiftLint → unit tests → archive); Fastlane lanes; SonarCloud + Snyk; configurable minimum iOS version (15.0–17.0); optional Firebase Crashlytics.
- **`flutter-app`** — Dart multi-platform template (Android / iOS / Web); optional Flutter Web K8s deploy (Dockerfile + `helm-values-local.yaml`); GitHub Actions CI; Firebase integration optional.
- **`mobile-sdk`** — Shared SDK library scaffold for Android (Kotlin / GitHub Packages), iOS (Swift Package Manager), Flutter (pub.dev), or Kotlin Multiplatform; publish workflow on version-tagged releases.
- **`mobile-code-signing`** — Automated code signing add-on: Fastlane Match (S3) for iOS; keystore + AWS Secrets Manager for Android. Opens a PR on the target repo.
- **`mobile-app-store-deploy`** — Fastlane `deliver` (App Store) and `supply` (Google Play) release pipeline; `workflow_dispatch` + `release/**` triggers; version bump step.
- **`mobile-device-farm`** — Firebase TestLab add-on with configurable device matrix (low=1, medium=3, high=5 devices); `gcloud firebase test` integration; results to GCS.
- **`flutter-integration-test-suite`** — Flutter integration test scaffold; local emulator or Firebase TestLab mode; opens a PR on the target Flutter app repo.
- **5 mobile Tech Insights checks** — `has-min-sdk-version` (≥24 Android / ≥16.0 iOS), `has-crashlytics-enabled`, `has-accessibility-tests`, `has-app-size-budget`, `has-code-signing`; pushed to Prometheus + visible in Grafana QA dashboard.
- **Tech Radar** — 6 new entries: Kotlin (ADOPT), Swift/SwiftUI (ADOPT), Flutter/Dart (TRIAL), Fastlane (ADOPT), Firebase TestLab (TRIAL), AWS Device Farm (ASSESS).
- **Documentation** — `docs/mobile-platform.md` (full template reference), `backstage/catalog/docs/mobile-developer-guide.md` extended with iOS, code-signing, device-farm, and SDK sections.

#### DORA entity tab + enhanced FinOps cost overview
- **DORA tab** — Available at `/catalog/default/component/<name>/dora` on every Component entity. Four stat cards (Deploy Frequency, Lead Time, Change Failure Rate, MTTR) with Elite/High/Medium/Low performance band badges and 7-day SVG sparklines. Queries Prometheus via `/api/proxy/prometheus`; falls back to demo data with yellow banner when Prometheus is unreachable.
- **FinOps cost overview (enhanced)** — Date-range selector (24 h / 7 d / 30 d); breakdown by namespace, team, or container; stacked bar chart per time bucket (SVG); cost table with PV cost column, efficiency % badge (green ≥ 80%, amber, red), per-row mini stacked bar, and totals row.
- Both implemented in `backstage/app/packages/app/src/extensions.tsx`; Prometheus proxy added to `backstage/app-config.local.yaml`.
- **Documentation** — `docs/dora-finops.md`.

#### `recover-docker-restart.sh` — post-Docker-restart Kind recovery
- Patches `kubelet.conf` with the new API server IP, restarts `kindnet`/`kube-proxy`, replaces `ingress-nginx` pods, fixes Grafana PVC permissions (`chmod 700`), patches Prometheus operator liveness probe, restarts Backstage Docker Compose, and smoke-tests all 9 service URLs.
- Flags: `--skip-backstage`, `--dry-run`.
- **Documentation** — `docs/docker-recovery.md`.

### Changed

#### Template annotation standardisation (20 templates)
- All 15 test-suite templates, 3 AI/ML templates, and `terraform-module` updated to include optional `spec.owner` parameters and `catalog-info.yaml` annotations for: `grafana/alert-label-selector`, `pagerduty.com/service-id`, `idp.io/quality-gates: "coverage"`, `jira/project-key`, `sonarcloud.io/project-key`, `snyk.io/org-name`.
- An optional **Integrations** step added to test-suite templates prompting for PagerDuty service ID and Jira project key.

### Security

#### Production Backstage hardening (commit `e4e00dc`)
- **Guest auth removed** — `backstage/app-config.aws.yaml` no longer includes the `dangerouslyAllowOutsideDevelopment` guest provider; production requires GitHub OAuth.
- **Session secret from Secrets Manager** — `AUTH_SESSION_SECRET` injected via External Secrets Operator; no static fallback value.
- **TLS cert validation enabled** — `rejectUnauthorized: true` for the PostgreSQL connection in `kubernetes/backstage/configmap.yaml`.
- **No hardcoded AWS Account ID** — `aws/backstage/deployment.yaml` uses `${AWS_ACCOUNT_ID}` and `${AWS_REGION}` placeholders.
- Changes mirrored in `kubernetes/backstage/configmap.yaml`.

#### Dependabot: dompurify + tmp (commit `2536282`)
- `dompurify` pinned to `^3.2.5` (XSS fix); `tmp` to `^0.2.3` in `backstage/app/package.json` resolutions.
- `yarn.lock` regenerated.

### Fixed

#### Local/AWS parity
- **Prometheus proxy path** — `app-config.aws.yaml` and `kubernetes/backstage/configmap.yaml` had `/prometheus/api` as the proxy key. The DORA tab frontend requests `/api/proxy/prometheus/api/v1/query`, so Backstage was forwarding `/v1/query` to Prometheus instead of `/api/v1/query`, causing a 404 on AWS only. Renamed to `/prometheus` and added `pathRewrite: '^/api/proxy/prometheus': ''` in both files.
- **flutter-app missing `awsRoleArn` parameter** — The `set-repo-secrets` step referenced `${{ parameters.awsRoleArn }}` but the parameter was never declared. Any user who enabled Flutter Web deploy targeting AWS would hit a silent scaffold crash. Added `awsRoleArn` to the Deployment Target parameters section and wired it into `fetch:template` values.

#### CLI
- **`flutter-integration` and `deepeval` types silently rejected** — Both were missing from `templateRef` in `cli/cmd/idp/testsuite.go`; `idp scaffold test-suite --type flutter-integration` returned "unknown --type" error. Added both mappings.
- **API-only types gave generic error on `--local`** — `unit`, `component`, `iac`, `flutter-integration`, `deepeval` now return a clear actionable message instead of "unknown test suite type".
- **`cli-install` ldflags missing** — `make cli-install` always produced `idp --version` → `dev`. Added the same `-ldflags "-X main.version=..."` used by `cli-build`.

---

## [0.2.0] — 2026-05-31

### Added

#### Crossplane alongside Terraform (per-service AWS provisioning)
- **`terraform/iam-crossplane.tf`** — IRSA role assumed by Crossplane's upbound AWS providers (`StringLike` on `system:serviceaccount:crossplane-system:provider-aws-*`), with AWS-managed `*FullAccess` policies attached for S3, RDS, MSK, DynamoDB, SQS plus a tagging policy. New TF output `crossplane_aws_role_arn`.
- **`kubernetes/crossplane/`** — in-cluster Crossplane stack:
  - `providers/` — `provider-aws-{s3,rds,kafka,dynamodb,sqs}` pinned to v1.18.0, shared `DeploymentRuntimeConfig` for IRSA annotation, default `ProviderConfig` with `source: IRSA`.
  - `compositions/` — XRDs + Compositions for `XS3Bucket`, `XRDSInstance`, `XKafkaTopic`, `XDynamoTable`, `XSQSQueue`. Opinionated defaults: encryption on, public-access blocked, PITR on, `idp:provisioner/owner/cost-center` tags.
  - Reference `example-claim.yaml` per resource for hand-rolled testing.
- **`kubernetes/argocd/crossplane.yaml`** — three ArgoCD Applications ordered by sync-wave: core Helm chart (-10), providers (-5), compositions (0).
- **`scripts/bootstrap.sh` Phase 4.6a** — substitutes the TF-output IRSA role ARN into `deployment-runtime-config.yaml` and hands the stack to ArgoCD. Skips gracefully if TF state isn't present.
- **Backstage scaffolder templates** (parallel to existing TF-PR templates):
  - `s3-bucket-crossplane`, `rds-database-crossplane`, `kafka-topic-crossplane`
  - `dynamodb-table-crossplane`, `sqs-queue-crossplane` (no TF equivalent; new resource types)
  - Each opens a PR adding a single Claim YAML at `services/<ownerService>/claims/<name>.yaml`; ArgoCD's existing `idp-services` ApplicationSet picks them up automatically.
- **Documentation** — `docs/crossplane.md` (end-to-end flow + bootstrap), `docs/crossplane-vs-terraform.md` (decision matrix and tool-boundary rationale), `CLAUDE.md` architecture section, `README.md` infrastructure summary, `docs/architecture.md` IaC subsection + component inventory, `docs/golden-path.md` template list, `docs/getting-started.md` verification steps, `docs/readiness-checklist.md` Crossplane checks.

#### Shift-Left Quality Engineering programme
- **Skeleton CI hardening** — `nodejs-service`, `go-service`, `python-service`, and `react-frontend` templates now ship with a parallel `quality` job (lint + type-check, dependency vuln scan via `govulncheck`/`npm audit`/`pip-audit`, and Trivy filesystem scan for CVEs + secrets + misconfig), a 70% coverage threshold gate on the `test` job, JUnit + coverage artifact upload (7-day retention), and a `publish` job that requires both gates to pass.
- **Scorecard expansion (v0.2.0)** — `idpTechInsights.ts` retires the 6-check scorecard for an 11-check Bronze/Silver/Gold tier model. New facts: `has-coverage-gate`, `has-static-analysis`, `has-vuln-scan`, `has-contract-tests`, `has-e2e-tests`. Driven by the new `idp.io/quality-gates` annotation on every language skeleton's `catalog-info.yaml`.
- **Per-tier exporter metrics** — `observability/tech-insights-exporter/exporter.py` now publishes `idp_scorecard_tier_{bronze,silver,gold}` (nested) and `idp_scorecard_check_passed{check}` to Pushgateway + CloudWatch.
- **Flaky-test exporter** — `observability/flaky-test-exporter/` is a new K8s CronJob that pulls the last 10 GitHub Actions workflow runs per service repo, parses JUnit XML from the `test-results` artifact, and classifies tests as flaky (`passes > 0 AND fails > 0`). Publishes `idp_test_flaky_count`, `idp_test_flakiness_ratio`, `idp_test_pass_total`, `idp_test_fail_total` to Pushgateway / CloudWatch. Wired into both `bootstrap-local.sh` (Step 11a) and `bootstrap.sh` (Phase 4.4a2).
- **QA Grafana dashboard panels** — three new panels in `observability/grafana/dashboards/qa/qa-metrics.json`: flaky-test stat, top-15 flaky-test table, pass/fail stacked timeseries.
- **Programme documentation** — `docs/shift-left.md` (programme overview, tier model, adoption playbook, gates reference, success metrics), `docs/shift-left-pilot-kickoff.md` (one-page team brief, 2-hour kickoff agenda, 4-week cadence, week-4 retro format), and `docs/shift-left-demo-cheatsheet.md` (4-beat presenter script with template-to-stage Q&A map and live-failure recovery moves).
- **Pyramid-completion test-suite templates** — three new scaffolder templates closing previously-implicit pyramid layers, all "add-to-existing repo" (open a PR):
  - `unit-test-suite` — language-aware (Go / Node-Vitest / Python-pytest) with a configurable coverage gate (default 70%) and JUnit output for the flaky-test exporter. For brownfield repos that aren't using the platform's language skeletons.
  - `component-test-suite` — service-under-test as a black box with external HTTP dependencies stubbed by a WireMock sidecar in CI. Faster than `testcontainers-suite`, more realistic than unit tests.
  - `iac-test-suite` — `terraform fmt`/`validate` + tflint + Checkov (with SARIF upload to GitHub Security tab) + optional Terratest (real `terraform apply` against ephemeral AWS resources, OIDC-gated).
- **CLI parity** — `idp scaffold test-suite --type` now accepts `unit`, `component`, and `iac` (Backstage API mode; `--local` not yet supported for these three).

### Security

#### Dependabot remediation — 90 of 91 alerts fixed (May 2026)
- Bumped Backstage core to **v1.50.4** via `yarn backstage-cli versions:bump` (104+ `@backstage/*` packages and transitives).
- Bumped `@backstage/plugin-scaffolder-node` `^0.9.0` → `^0.13.2`.
- Added 27 yarn `resolutions` to pin patched versions of `axios`, `tar`, `undici`, `minimatch`, `protobufjs`, `jsonpath-plus`, `form-data`, `lodash`, `koa`, `dompurify`, `postcss`, `fast-uri`, `uuid`, `@octokit/*`, `qs`, `cookie`, `fast-xml-parser` (`^5.7.0`), `@tootallnate/once` (`^3.0.1`), and others.
- **Replaced abandoned `vm2`** with a local shim at `backstage/app/vm2-shim/` (thin wrapper over Node's built-in `vm` module). Pulled in transitively via `typescript-json-schema` ← `@backstage/config-loader`; no upstream fix existed.
- `services/idp-mcp-server`: `hono` → 4.12.19, `ip-address` → 10.2.0.
- `react-frontend` scaffold: `vite` `^5.4.0` → `^6.4.2`.
- Dismissed `elliptic` (no upstream fix) and `request` (deprecated, not used).
- See `docs/security.md` for the full posture write-up.

### Changed
- `.github/dependabot.yml`: disabled automated version-update PRs (`open-pull-requests-limit: 0` for npm and Docker). Two prior auto-bumps (`uuid` v9→v10, `scaffolder-node` `/alpha` move) broke working configs. Security alerts still surface.

### Fixed

#### First-install / local-setup stabilisation (commit `1bde323`)
- **Backstage**: imported `scaffolderActionsExtensionPoint` from `@backstage/plugin-scaffolder-node` main package (was `/alpha`, undefined) — the crash had blocked the catalog refresh loop and left `final_entities` at 0 on first install.
- **Backstage**: registered `@backstage/plugin-notifications-backend` in `packages/backend/src/index.ts` (was installed but never `backend.add()`-ed, causing 404 on `/api/notifications`).
- **Backstage**: yarn patch for `@material-table/core` v3 — rewrites `_uuid["default"].v4()` to `(_uuid["default"] || _uuid).v4()` so the catalog, api-docs, and techdocs pages don't crash on `uuid` v10.
- **Backstage**: swapped the Backstage `Table` for `@material-ui/core` `Table` on the FinOps page (same uuid-default issue).
- **Backstage**: added `dangerouslyDisableDefaultAuthPolicy: true` to `app-config.local.yaml` to prevent a 401 flash before guest sign-in completes (Backstage v1.29+).
- **Backstage**: disabled standalone `/kubernetes` and `/catalog-graph` pages (both crash with "Entity context is not available"); entity-tab versions still work. Re-added `page:catalog` at `/` so the root is not a 404.
- **idp-mcp-server**: implemented the `get_template_params` tool that was referenced in `idp-agent.yaml` `toolNames` but never implemented (caused "No description available" in the KAgent UI).
- **`scripts/setup.sh`**: replaced `xargs -I{} _sed` with a `while`-read loop — `xargs` spawns subprocesses that can't see shell functions, so `moatazeldebsy` was never replaced in `local/argocd/app-of-apps-local.yaml`. Also narrowed the find scope from 258k files (including `node_modules`) to 542 targeted files.
- **`scripts/bootstrap-local.sh`**: same `xargs`/`_sed` fix in `_apply_personalization`; also uninstall the stray `hello-service` from the `services` namespace after the ArgoCD ApplicationSet is applied so the nginx admission webhook stops rejecting the `services-dev` ingress.
- **`scripts/bootstrap-ai.sh`**: fall back to direct Helm for `idp-mcp-server` and `qa-mcp-server` when the ArgoCD app doesn't exist yet (first-time install before app-of-apps runs).
- **Grafana**: bumped memory limit 256Mi → 512Mi (request 128Mi → 256Mi) — pod was OOMKilled at ~326Mi on dashboard load. Added `proxy-next-upstream: http_503` and relaxed readiness/liveness probes (`failureThreshold` 3 → 10, `timeoutSeconds` 1 → 5).

#### Docker & CI
- `backstage/Dockerfile`: copy `vm2-shim/` **before** `yarn workspaces focus` so the focus step resolves the local shim instead of trying to fetch abandoned `vm2` (commit `b98c924`).
- `.github/workflows/ci.yml`: suppress the harmless `protobufjs` dynamic-require warning that was failing the Backstage build under stricter Node settings (commit `dd4cd3b`).

#### AWS bootstrap
- `scripts/bootstrap.sh`: added the missing `fi` for the `SKIP_POLICIES` conditional opened at Phase 3.8. Without it the script failed `bash -n` and every phase after OPA install ran inside the conditional — meaning `--skip-policies` silently turned the entire AWS bootstrap into a no-op past Phase 3.7.
- `scripts/bootstrap.sh`: dropped redundant host-side `yarn install --frozen-lockfile && yarn build:backend` from Phase 5.5 — the multi-stage `backstage/Dockerfile` does this inside the builder image.
- `kubernetes/argocd/app-of-apps.yaml` + 10 other files: rewrote stale `backstage-idp-starter` repo URL to `backstage-platform-template` so the AWS ArgoCD ApplicationSet can actually clone the repo.
- `services/contract-mcp-server/helm-values-dev.yaml`: new — unblocks the AWS deployment loop in `bootstrap-ai.sh:448`, which already iterates `contract-mcp-server` but had no values file to substitute the ECR placeholder into.
- `observability/prometheus-stack-values-aws.yaml`: bumped Grafana to `replicas: 2`, disabled persistence (gp2 is RWO; can't share PVC), added lenient probes and ALB health-check config so dashboard reload no longer surfaces 503s.

#### Runbooks
- Added `docs/runbooks/kind-node-ip-mismatch.md` (commit `aaeee62`) — recovery procedure for the Docker/Rancher-crash failure mode where the Kind node IP drifts and `*.idp.local` stops resolving.

### Added

#### Contract Testing with MCP — Self-Describing, Self-Testing APIs

- `services/contract-mcp-server/` — TypeScript MCP server (port 3003) with 9 tools:
  - `fetch_service_contract` — pull `/openapi.json` from a live service and auto-register (self-describing pattern)
  - `auto_discover_contracts` — scan an entire Kubernetes namespace, register every service that exposes a spec (one call makes the platform self-describing)
  - `register_contract` — manually push an OpenAPI 3.x spec (JSON or YAML)
  - `get_contract` / `list_contracts` — retrieve stored contracts
  - `generate_contract_tests` — produce Pact V3 JSON + TypeScript test code from a provider spec
  - `validate_compatibility` — check if a provider satisfies all consumer-expected paths
  - `detect_breaking_changes` — diff two spec versions; surfaces removed paths, methods, and new required params
  - `get_compatibility_report` — full consumer/provider compatibility matrix for a service
- `kubernetes/kagent/contract-toolserver.yaml` — KAgent `RemoteMCPServer` pointing to the contract-mcp-server in-cluster endpoint
- `kubernetes/kagent/contract-agent.yaml` — KAgent `contract-assistant` Agent with all 9 contract tools plus `catalog_search` and `list_deployments` from idp-mcp-server
- `backstage/catalog/templates/contract-testing-suite/` — Backstage scaffolder template (new-repo and add-to-existing modes) that generates: consumer contract spec (`contract/openapi.yaml`), Pact V3 consumer tests, CI workflow with auto-registration, and catalog entity
- `backstage/catalog/services/contract-mcp-server/catalog-info.yaml` — Backstage catalog entity for the contract-mcp-server component
- `helm/service-template/templates/contract-hook-job.yaml` + `contractCheck` values — opt-in ArgoCD PostSync (auto-describe + compatibility report after every deploy) and PreSync (break deploy if breaking changes detected) hooks for any service using the golden-path Helm chart
- `services/hello-service/src/main.go` — added `GET /openapi.json` handler so hello-service is self-describing out of the box; returns live OpenAPI 3.0 spec including the running binary version
- `docs/contract-testing.md` — full how-to guide: making services self-describing, agent prompts, Helm hook configuration, MCP tool reference, troubleshooting
- `local/hosts-append.txt` and `local/backstage/docker-compose.yml` — added `contract-mcp-server.idp.local` hostname and extra_hosts entry
- `backstage/app-config.local.yaml` — added `/contract-mcp` Backstage proxy endpoint
- `.github/workflows/ci.yml` — added `contract-mcp-server-build` job (TypeScript compile on every PR touching `services/contract-mcp-server/`)



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

Initial open-source release of the backstage-platform-template template.

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
- `Moataz Nabil` placeholder restored in catalog-info.yaml (was hardcoded)
- `moatazeldebsy`/`backstage-platform-template` documentation tokens now substituted by setup.sh
- build-and-deploy.yml: graceful skip when `AWS_ROLE_ARN` secret is not set

[Unreleased]: https://github.com/moatazeldebsy/backstage-platform-template/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/moatazeldebsy/backstage-platform-template/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/moatazeldebsy/backstage-platform-template/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/moatazeldebsy/backstage-platform-template/releases/tag/v0.1.0
[0.1.0]: https://github.com/moatazeldebsy/backstage-platform-template/releases/tag/v0.1.0
