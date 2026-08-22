# Mobile Device Farm

Adds real-device testing to a mobile app that already exists in the catalog. It
opens a pull request against that app's repository — it does not create a new one.

## Providers

| | Firebase Test Lab | LambdaTest |
|---|---|---|
| Credential | `GCP_SERVICE_ACCOUNT_KEY` | `LT_USERNAME` + `LT_ACCESS_KEY` |
| Extra setup | A GCP project with Test Lab enabled | None |
| Device matrix | `device-matrix/firebase/{low,medium,high}.yml` (gcloud `--device-spec` format) | `device-matrix/lambdatest/{low,medium,high}.json` |
| Execution modes | Device grid | Device grid, or HyperExecute |

Both credentials are injected into the target repository automatically by the
`idp:repo:set-secrets` step, sourced from the Backstage backend's own
environment — `local/backstage/.env` locally, the `backstage-secrets` Kubernetes
secret on AWS. If a credential is not set on the platform, the scaffolder still
succeeds and the step logs which secret it skipped; the generated workflow then
fails on its first run with an explicit error rather than a confusing 401.

## Coverage tiers

`low` is 1 device (~5 min), `medium` is 3 (~15 min), `high` is 5 including a
tablet (~30 min). The tier picks a matrix file; edit that file afterwards to
change the exact devices without re-running the template.

## Execution modes (LambdaTest only)

**Device Grid** is the direct equivalent of Test Lab: the workflow builds the
app, uploads the app and test binaries, triggers a build across the matrix, and
polls until it reaches a terminal state.

**HyperExecute** hands orchestration to LambdaTest instead. It adds a
`hyperexecute.yaml` that the HyperExecute CLI drives, with concurrency matched
to the coverage tier. Worth it for large suites where sharding dominates
wall-clock time; unnecessary for a handful of smoke tests.

## What lands in the repository

- `.github/workflows/device-farm.yml` — runs on every push and pull request
- `device-matrix/` — both providers' matrices, so switching later is an edit
- `hyperexecute.yaml` — only when HyperExecute mode is selected

The workflow posts a summary comment on pull requests with a link to the
provider's result page, uploads the raw result JSON as an artifact for 14 days,
and fails the job when tests fail.

## Related

- `appium-mobile-suite` — a standalone Appium/WebdriverIO suite, which can also
  target LambdaTest real devices
- `flutter-integration-test-suite` — Flutter integration tests on Test Lab or a
  local emulator
- See `docs/mobile-platform.md` in the platform repository for the full mobile
  golden path
