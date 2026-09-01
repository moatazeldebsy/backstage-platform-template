# Flaky-Test Quarantine

How the platform detects flaky tests and acts on them automatically, instead of just reporting the
number in Grafana.

## The two-part mechanism

**Detection** — `observability/flaky-test-exporter/exporter.py` runs as a Kubernetes CronJob every
30 minutes. For every Backstage `Component` with a `github.com/project-slug` annotation, it pulls the
last `WINDOW_SIZE` (default 10) completed GitHub Actions runs on the default branch, downloads each
run's `test-results*` JUnit artifacts, and classifies every test as:

- `stable_pass` — passed in every observed run
- `stable_fail` — failed in every observed run (a deterministic bug, not a flake)
- `flaky` — passed at least once **and** failed at least once in the window

Results are published as Prometheus metrics (`idp_test_flaky`, `idp_test_flakiness_ratio`,
`idp_test_service_flakiness_ratio`, `idp_test_flaky_count`, `idp_test_runs_window`,
`idp_test_pass_total`, `idp_test_fail_total`) via
Pushgateway locally or CloudWatch on AWS (`MODE=cloudwatch`).

**Action** — `observability/flaky-test-exporter/quarantine.py` runs as a separate daily CronJob
(`0 6 * * *`, deliberately much less frequent than the 30-minute detection cadence, so it doesn't open
a new PR on every tick). It reuses `exporter.py`'s classification (`collect()`, `ServiceFlakiness`) and,
for every service with at least `MIN_RUNS` observed runs, opens or updates a PR against that service's
own repo updating `flaky-quarantine.yaml` at the repo root:

- Newly flaky tests are added, each with `test`, `suite`, `flakiness_ratio`, `first_detected`, and a
  `reason`.
- Tests that are no longer flaky (stable across a full window) are proposed for removal in the same PR.
- If a quarantine PR is already open on the `flaky-quarantine/auto-update` branch, new commits are
  pushed to it rather than opening a duplicate.

## How golden-path CI consumes it

The python-service skeleton's `tests/conftest.py` reads `flaky-quarantine.yaml` and marks each
quarantined test `xfail(strict=False)` via `pytest_collection_modifyitems`. A quarantined test still
runs and still reports pass/fail in the JUnit output the exporter reads — it just can't turn the build
red. Test IDs match `exporter.py`'s `<classname>/<name>` convention (or bare test name for
function-style tests).

`flaky-quarantine.yaml` itself starts empty (`quarantined: []`) in the skeleton and is meant to be
edited only by the sync job — a comment in the file tells contributors not to hand-edit it except to
remove a fixed test, since the sync job will re-add anything still genuinely flaky.

## Un-quarantining a test

Fix the underlying flakiness, then remove its entry from `flaky-quarantine.yaml` (by hand, in a normal
PR). The next quarantine sync run will not re-add it once the test is stable across a full observed
window (`MIN_RUNS`, default equal to `WINDOW_SIZE`).

## Deployment

Both CronJobs are deployed by `scripts/bootstrap.sh` / `scripts/bootstrap-local.sh`, which build a
single `flaky-test-exporter-script` ConfigMap containing both `exporter.py` and `quarantine.py` (the
quarantine job imports classification logic directly from the exporter module, so both files must be
present):

```bash
kubectl create configmap flaky-test-exporter-script \
  --from-file=exporter.py=observability/flaky-test-exporter/exporter.py \
  --from-file=quarantine.py=observability/flaky-test-exporter/quarantine.py \
  -n monitoring --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f observability/flaky-test-exporter/cronjob.yaml
kubectl apply -f observability/flaky-test-exporter/quarantine-cronjob.yaml
```

Both jobs share the same `GITHUB_TOKEN` secret (`flaky-test-exporter-github-token`) — the quarantine
job needs the same `repo` scope already required for reading Actions artifacts, plus permission to
create branches, commit files, and open PRs.
