#!/usr/bin/env python3
"""
Flaky-Test Exporter

Pulls the last N workflow runs from every service repo registered in the
Backstage catalog, downloads each run's `test-results` artifact (JUnit XML +
coverage), and classifies each test as:

  - stable_pass   — passed in every observed run
  - stable_fail   — failed in every observed run (a deterministic bug, not flake)
  - flaky         — passed at least once AND failed at least once in the window

Publishes Prometheus metrics to Pushgateway (local) or CloudWatch (AWS).

Runs as a Kubernetes CronJob every 30 minutes. Stateless — re-derives
classification from the last N workflow artifacts on each tick.

Environment variables
  BACKSTAGE_URL       — Backstage base URL (catalog source of truth)
  BACKSTAGE_TOKEN     — Backstage service token
  GITHUB_TOKEN        — PAT with `repo` + `actions:read` scopes
  PUSHGATEWAY_URL     — Pushgateway URL (default: in-cluster)
  MODE                — "pushgateway" (local) or "cloudwatch" (AWS)
  CLOUDWATCH_NS       — CloudWatch namespace (AWS mode)
  AWS_REGION          — AWS region (AWS mode)
  WINDOW_SIZE         — number of recent workflow runs per repo (default: 10)
  ARTIFACT_NAME       — artifact name prefix uploaded by skeleton CI (default:
                        test-results; `test-results-<job>` also matches)
"""
import io
import logging
import os
import sys
import xml.etree.ElementTree as ET
import zipfile
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Iterable

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

BACKSTAGE_URL   = os.environ.get("BACKSTAGE_URL", "http://localhost:7007")
BACKSTAGE_TOKEN = os.environ.get("BACKSTAGE_TOKEN", "")
GITHUB_TOKEN    = os.environ.get("GITHUB_TOKEN", "")
PUSHGATEWAY_URL = os.environ.get("PUSHGATEWAY_URL", "http://prometheus-pushgateway.monitoring:9091")
MODE            = os.environ.get("MODE", "pushgateway")
CW_NAMESPACE    = os.environ.get("CLOUDWATCH_NS", "IDP/FlakyTests")
AWS_REGION      = os.environ.get("AWS_REGION", "us-east-1")
WINDOW_SIZE     = int(os.environ.get("WINDOW_SIZE", "10"))
ARTIFACT_NAME   = os.environ.get("ARTIFACT_NAME", "test-results")
# Hard cardinality cap: never emit per-test metrics for more than this many
# tests per service. Surfaces the worst offenders; protects Prometheus.
PER_TEST_CAP    = int(os.environ.get("PER_TEST_CAP", "20"))

BACKSTAGE_HEADERS = {"Authorization": f"Bearer {BACKSTAGE_TOKEN}"} if BACKSTAGE_TOKEN else {}
GITHUB_HEADERS = {
    "Authorization": f"Bearer {GITHUB_TOKEN}",
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
}


@dataclass
class TestResult:
    """Aggregated outcomes for a single test across the workflow run window."""
    test_id: str    # canonical "<classname>/<name>"
    suite: str      # JUnit testsuite name (file or module)
    passes: int = 0
    fails: int = 0
    skips: int = 0

    @property
    def is_flaky(self) -> bool:
        return self.passes > 0 and self.fails > 0

    @property
    def flakiness_ratio(self) -> float:
        total = self.passes + self.fails
        return self.fails / total if total else 0.0


@dataclass
class ServiceFlakiness:
    service: str
    team: str
    repo: str            # "owner/name"
    results: dict[str, TestResult] = field(default_factory=dict)
    runs_observed: int = 0
    # True when GitHub could not be queried at all (auth/network), as opposed to
    # a healthy repo that simply has no flaky tests. Zeroed metrics for the two
    # cases are indistinguishable downstream, so the caller checks this before
    # publishing anything.
    fetch_failed: bool = False

    def record(self, test_id: str, suite: str, outcome: str) -> None:
        tr = self.results.setdefault(test_id, TestResult(test_id=test_id, suite=suite))
        if outcome == "pass":
            tr.passes += 1
        elif outcome == "fail":
            tr.fails += 1
        elif outcome == "skip":
            tr.skips += 1

    @property
    def flaky_tests(self) -> list[TestResult]:
        flakes = [r for r in self.results.values() if r.is_flaky]
        # Worst flakiness first; cap to PER_TEST_CAP.
        flakes.sort(key=lambda r: r.flakiness_ratio, reverse=True)
        return flakes[:PER_TEST_CAP]

    @property
    def totals(self) -> dict[str, int]:
        return {
            "passes": sum(r.passes for r in self.results.values()),
            "fails":  sum(r.fails  for r in self.results.values()),
            "skips":  sum(r.skips  for r in self.results.values()),
        }


# ── Backstage catalog ───────────────────────────────────────────────────────
def fetch_service_repos() -> list[tuple[str, str, str]]:
    """Returns (service_name, team, "owner/repo") for every Component with a
    github.com/project-slug annotation."""
    url = f"{BACKSTAGE_URL}/api/catalog/entities?filter=kind=Component"
    resp = requests.get(url, headers=BACKSTAGE_HEADERS, timeout=30)
    resp.raise_for_status()
    out = []
    for entity in resp.json():
        meta = entity.get("metadata", {})
        spec = entity.get("spec", {})
        slug = (meta.get("annotations") or {}).get("github.com/project-slug")
        if not slug or "/" not in slug:
            continue
        out.append((meta.get("name", "unknown"), spec.get("owner", "unknown"), slug))
    return out


# ── GitHub Actions ──────────────────────────────────────────────────────────
def list_recent_runs(repo: str) -> list[dict]:
    """Return up to WINDOW_SIZE most-recent completed workflow runs on the
    default branch. Skips in-progress runs."""
    # We don't filter by status — both successful and failed runs are useful
    # for flakiness signal. We do skip "in_progress" / "queued".
    url = f"https://api.github.com/repos/{repo}/actions/runs"
    params = {"per_page": WINDOW_SIZE * 2, "status": "completed"}
    resp = requests.get(url, headers=GITHUB_HEADERS, params=params, timeout=30)
    if resp.status_code == 404:
        log.warning("Repo not found or token lacks access: %s", repo)
        return []
    resp.raise_for_status()
    return resp.json().get("workflow_runs", [])[:WINDOW_SIZE]


def matches_artifact_name(name: str) -> bool:
    """Whether an artifact holds test results for us.

    Matched on *prefix*, not equality. A repository with more than one test job
    cannot name two artifacts `test-results` — upload-artifact@v4 rejects a
    duplicate name within a run — so a multi-language repo has to publish
    `test-results-go`, `test-results-python` and so on. Exact `test-results`
    still matches, so single-job repositories are unaffected.
    """
    return name == ARTIFACT_NAME or name.startswith(f"{ARTIFACT_NAME}-")


def fetch_junit_artifacts(repo: str, run_id: int) -> list[bytes]:
    """Download every test-results artifact ZIP for a run.

    Returns all matches rather than the first: a run whose Go tests passed and
    whose Python tests failed has to contribute both, or the failure is invisible
    and the run scores as clean.
    """
    url = f"https://api.github.com/repos/{repo}/actions/runs/{run_id}/artifacts"
    resp = requests.get(url, headers=GITHUB_HEADERS, timeout=30)
    if not resp.ok:
        return []
    blobs: list[bytes] = []
    for artifact in resp.json().get("artifacts", []):
        if not matches_artifact_name(artifact.get("name", "")) or artifact.get("expired"):
            continue
        dl = requests.get(
            artifact["archive_download_url"],
            headers=GITHUB_HEADERS,
            timeout=60,
            allow_redirects=True,
        )
        if dl.ok:
            blobs.append(dl.content)
        else:
            log.warning("Failed to download artifact for run %s: %s", run_id, dl.status_code)
    return blobs


# ── JUnit parsing ───────────────────────────────────────────────────────────
def iter_testcases(zip_bytes: bytes) -> Iterable[tuple[str, str, str]]:
    """Yield (test_id, suite, outcome) tuples from every JUnit XML in the ZIP.
    outcome is one of: pass, fail, skip."""
    try:
        zf = zipfile.ZipFile(io.BytesIO(zip_bytes))
    except zipfile.BadZipFile:
        return
    for name in zf.namelist():
        if not name.endswith(".xml"):
            continue
        try:
            data = zf.read(name)
            root = ET.fromstring(data)
        except (ET.ParseError, KeyError):
            continue
        # JUnit XML may be wrapped in <testsuites> or be a bare <testsuite>.
        suites = root.findall(".//testsuite") if root.tag == "testsuites" else [root]
        for suite_el in suites:
            suite_name = suite_el.get("name") or name
            for tc in suite_el.findall("testcase"):
                classname = tc.get("classname", "")
                tname     = tc.get("name", "")
                test_id   = f"{classname}/{tname}" if classname else tname
                if not test_id:
                    continue
                if tc.find("failure") is not None or tc.find("error") is not None:
                    yield test_id, suite_name, "fail"
                elif tc.find("skipped") is not None:
                    yield test_id, suite_name, "skip"
                else:
                    yield test_id, suite_name, "pass"


# ── Aggregation ─────────────────────────────────────────────────────────────
def collect() -> list[ServiceFlakiness]:
    out: list[ServiceFlakiness] = []
    services = fetch_service_repos()
    log.info("Found %d catalog services with github.com/project-slug", len(services))

    for name, team, repo in services:
        sf = ServiceFlakiness(service=name, team=team, repo=repo)
        try:
            runs = list_recent_runs(repo)
        except Exception as e:
            log.warning("Skipping %s (%s): list_recent_runs failed: %s", name, repo, e)
            sf.fetch_failed = True
            out.append(sf)
            continue

        if not runs:
            log.info("%s — no completed runs in window", name)
            out.append(sf)
            continue

        for run in runs:
            run_id = run["id"]
            try:
                blobs = fetch_junit_artifacts(repo, run_id)
            except Exception as e:
                log.debug("Skipping run %s artifact: %s", run_id, e)
                continue
            if not blobs:
                continue
            # One run counts once however many test jobs it published, or a
            # multi-job repo would look like it ran more often than it did.
            sf.runs_observed += 1
            for blob in blobs:
                for test_id, suite, outcome in iter_testcases(blob):
                    sf.record(test_id, suite, outcome)

        log.info(
            "%s — %d/%d runs had artifacts; %d distinct tests; %d flaky",
            name, sf.runs_observed, len(runs), len(sf.results), len(sf.flaky_tests),
        )
        out.append(sf)

    return out


# ── Pushgateway ─────────────────────────────────────────────────────────────
def _escape(label_value: str) -> str:
    # Prometheus label values must escape \, ", and newline.
    return label_value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")


def push_to_pushgateway(services: list[ServiceFlakiness]) -> None:
    lines = []
    lines.append("# HELP idp_test_runs_window Number of workflow runs scanned per service for flakiness classification")
    lines.append("# TYPE idp_test_runs_window gauge")
    for s in services:
        labels = f'service="{_escape(s.service)}",team="{_escape(s.team)}"'
        lines.append(f'idp_test_runs_window{{{labels}}} {s.runs_observed}')

    lines.append("# HELP idp_test_flaky_count Number of distinct tests classified as flaky for this service")
    lines.append("# TYPE idp_test_flaky_count gauge")
    for s in services:
        labels = f'service="{_escape(s.service)}",team="{_escape(s.team)}"'
        lines.append(f'idp_test_flaky_count{{{labels}}} {len(s.flaky_tests)}')

    lines.append("# HELP idp_test_pass_total Total test passes observed in the window")
    lines.append("# TYPE idp_test_pass_total gauge")
    for s in services:
        labels = f'service="{_escape(s.service)}",team="{_escape(s.team)}"'
        lines.append(f'idp_test_pass_total{{{labels}}} {s.totals["passes"]}')

    lines.append("# HELP idp_test_fail_total Total test failures observed in the window")
    lines.append("# TYPE idp_test_fail_total gauge")
    for s in services:
        labels = f'service="{_escape(s.service)}",team="{_escape(s.team)}"'
        lines.append(f'idp_test_fail_total{{{labels}}} {s.totals["fails"]}')

    # Per-test, capped to the top PER_TEST_CAP flakiest. Only emitted for tests
    # currently classified flaky; stable tests don't add cardinality.
    lines.append("# HELP idp_test_flaky 1 if the named test is currently classified as flaky")
    lines.append("# TYPE idp_test_flaky gauge")
    lines.append("# HELP idp_test_flakiness_ratio Fraction of observations in the window that were failures (0=stable pass, 1=stable fail)")
    lines.append("# TYPE idp_test_flakiness_ratio gauge")
    for s in services:
        for tr in s.flaky_tests:
            labels = (
                f'service="{_escape(s.service)}",team="{_escape(s.team)}",'
                f'test="{_escape(tr.test_id)}",suite="{_escape(tr.suite)}"'
            )
            lines.append(f'idp_test_flaky{{{labels}}} 1')
            lines.append(f'idp_test_flakiness_ratio{{{labels}}} {tr.flakiness_ratio:.4f}')

    payload = "\n".join(lines) + "\n"
    url = f"{PUSHGATEWAY_URL}/metrics/job/flaky-test-exporter"
    # DELETE first so removed flaky tests stop reporting stale values.
    requests.delete(url, timeout=15)
    resp = requests.post(url, data=payload, timeout=30)
    resp.raise_for_status()
    log.info("Pushed flakiness metrics for %d services to Pushgateway", len(services))


# ── CloudWatch ──────────────────────────────────────────────────────────────
def push_to_cloudwatch(services: list[ServiceFlakiness]) -> None:
    import boto3
    cw = boto3.client("cloudwatch", region_name=AWS_REGION)
    data = []
    for s in services:
        base = [
            {"Name": "Service", "Value": s.service},
            {"Name": "Team",    "Value": s.team},
        ]
        data.append({"MetricName": "FlakyTestCount", "Dimensions": base, "Value": len(s.flaky_tests), "Unit": "Count"})
        data.append({"MetricName": "TestRunsWindow", "Dimensions": base, "Value": s.runs_observed, "Unit": "Count"})
        data.append({"MetricName": "TestPassTotal",  "Dimensions": base, "Value": s.totals["passes"], "Unit": "Count"})
        data.append({"MetricName": "TestFailTotal",  "Dimensions": base, "Value": s.totals["fails"],  "Unit": "Count"})
        # Per-test ratios — capped.
        for tr in s.flaky_tests:
            data.append({
                "MetricName": "TestFlakinessRatio",
                "Dimensions": base + [
                    {"Name": "Test",  "Value": tr.test_id[:255]},
                    {"Name": "Suite", "Value": tr.suite[:255]},
                ],
                "Value": tr.flakiness_ratio,
                "Unit": "None",
            })
    for i in range(0, len(data), 20):
        cw.put_metric_data(Namespace=CW_NAMESPACE, MetricData=data[i:i+20])
    log.info("Published %d flaky-test metrics to CloudWatch namespace %s", len(data), CW_NAMESPACE)


# ── Main ────────────────────────────────────────────────────────────────────
def main() -> None:
    if not GITHUB_TOKEN:
        log.error("GITHUB_TOKEN is required")
        sys.exit(1)

    try:
        services = collect()
    except Exception as e:
        log.error("collect() failed: %s", e)
        sys.exit(1)

    if not services:
        log.warning("No services to report on")
        return

    # Every repo failed to fetch — almost always a bad or placeholder token.
    # Publishing here would report zero flakiness for every service, which reads
    # as "nothing is flaky" rather than "no data was collected". Fail loudly so
    # the CronJob surfaces it instead of silently poisoning the dashboard.
    if all(s.fetch_failed for s in services):
        log.error(
            "All %d services failed to fetch from GitHub (check GITHUB_TOKEN "
            "scopes: repo + actions:read) — refusing to publish empty metrics",
            len(services),
        )
        sys.exit(1)

    if MODE == "cloudwatch":
        push_to_cloudwatch(services)
    else:
        push_to_pushgateway(services)


if __name__ == "__main__":
    main()
