"""Behavioural tests for the Developer Experience metrics in the DORA exporters.

Two failures this file prevents.

**Pushing a zero for something that did not happen.** The Engineering
Intelligence scoring engine reads an absent sample as reduced coverage but a
zero as a real measurement. A repo with no merged pull requests must produce no
`devex_pr_cycle_time_hours` series at all — publishing 0.0 would claim every
change merges instantly.

**The two exporters drifting apart.** `local/observability/dora/dora-exporter.py`
and `aws/observability/dora/dora-exporter.py` are a known drift pair: different
discovery, team mapping and CloudWatch handling, but the DevEx computations must
be identical. They cannot share a module — each is deployed as a single-file
ConfigMap — so every test below runs against *both* copies, and the last test
compares them directly.

The exporters read `GITHUB_TOKEN` and import `requests` / `prometheus_client` at
module scope, so both are stubbed before loading. Only the pure functions are
exercised; nothing here touches the network.
"""

import importlib.util
import os
import sys
import types
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
EXPORTERS = {
    "local": REPO_ROOT / "local" / "observability" / "dora" / "dora-exporter.py",
    "aws": REPO_ROOT / "aws" / "observability" / "dora" / "dora-exporter.py",
}


def _stub_third_party() -> None:
    """Stand in for the packages the exporters import at module scope."""
    os.environ.setdefault("GITHUB_TOKEN", "test-token")

    if "requests" not in sys.modules:
        requests = types.ModuleType("requests")
        requests.get = lambda *a, **k: None  # never called by the pure functions
        sys.modules["requests"] = requests

    if "prometheus_client" not in sys.modules:
        prom = types.ModuleType("prometheus_client")
        prom.CollectorRegistry = type("CollectorRegistry", (), {})
        prom.Gauge = type("Gauge", (), {})
        prom.push_to_gateway = lambda *a, **k: None
        sys.modules["prometheus_client"] = prom


def _load(name: str, path: Path):
    _stub_third_party()
    spec = importlib.util.spec_from_file_location(f"dora_exporter_{name}", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


MODULES = {name: _load(name, path) for name, path in EXPORTERS.items()}
BOTH = pytest.mark.parametrize("mod", MODULES.values(), ids=list(MODULES))

NOW = datetime(2026, 8, 28, 12, 0, 0, tzinfo=timezone.utc)
SINCE = NOW - timedelta(hours=24)


def iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def pr(created: datetime, merged=None) -> dict:
    return {"created_at": iso(created), "merged_at": iso(merged) if merged else None}


def run(created: datetime, finished: datetime, conclusion: str) -> dict:
    return {
        "created_at": iso(created),
        "updated_at": iso(finished),
        "conclusion": conclusion,
    }


# ── pull request cycle time ───────────────────────────────────────────────────


@BOTH
def test_pr_cycle_time_is_open_to_merge(mod):
    prs = [
        pr(NOW - timedelta(hours=10), NOW - timedelta(hours=8)),  # 2h
        pr(NOW - timedelta(hours=10), NOW - timedelta(hours=6)),  # 4h
    ]
    assert mod.compute_pr_cycle_time(prs, SINCE) == pytest.approx(3.0)


@BOTH
def test_pr_cycle_time_ignores_prs_closed_without_merging(mod):
    # Abandoning a change is not a slow review. Counting it as one would make a
    # team look worse for cleaning up after itself.
    prs = [
        pr(NOW - timedelta(hours=10), NOW - timedelta(hours=8)),  # 2h, merged
        pr(NOW - timedelta(days=40), None),  # closed unmerged, ancient
    ]
    assert mod.compute_pr_cycle_time(prs, SINCE) == pytest.approx(2.0)


@BOTH
def test_pr_cycle_time_ignores_merges_before_the_window(mod):
    prs = [
        pr(NOW - timedelta(hours=3), NOW - timedelta(hours=1)),  # 2h, in window
        pr(NOW - timedelta(days=9), NOW - timedelta(days=8)),  # 24h, too old
    ]
    assert mod.compute_pr_cycle_time(prs, SINCE) == pytest.approx(2.0)


@BOTH
def test_pr_cycle_time_is_zero_when_nothing_merged(mod):
    # The function returns 0.0, and the caller must translate that into *not
    # pushing the series*. main() is what enforces it; this pins the contract
    # the caller depends on.
    assert mod.compute_pr_cycle_time([], SINCE) == 0.0
    assert mod.compute_pr_cycle_time([pr(NOW, None)], SINCE) == 0.0


# ── CI duration ───────────────────────────────────────────────────────────────


@BOTH
def test_ci_duration_includes_queue_time(mod):
    # Measured from created_at, not run_started_at: waiting for a runner is time
    # the developer waits, and excluding it would flatter a starved platform.
    runs = [
        run(NOW - timedelta(minutes=30), NOW - timedelta(minutes=20), "success"),  # 10m
        run(NOW - timedelta(minutes=30), NOW - timedelta(minutes=10), "failure"),  # 20m
    ]
    assert mod.compute_ci_duration(runs) == pytest.approx(15.0)


@BOTH
def test_ci_duration_ignores_runs_without_a_verdict(mod):
    runs = [
        run(NOW - timedelta(minutes=30), NOW - timedelta(minutes=20), "success"),  # 10m
        run(NOW - timedelta(minutes=90), NOW - timedelta(minutes=1), "cancelled"),
        run(NOW - timedelta(minutes=90), NOW - timedelta(minutes=1), None),
    ]
    assert mod.compute_ci_duration(runs) == pytest.approx(10.0)


@BOTH
def test_ci_duration_is_zero_when_nothing_ran(mod):
    assert mod.compute_ci_duration([]) == 0.0


# ── build failure ratio ───────────────────────────────────────────────────────


@BOTH
def test_build_failure_ratio_counts_only_decided_runs(mod):
    runs = [
        run(NOW, NOW, "success"),
        run(NOW, NOW, "success"),
        run(NOW, NOW, "success"),
        run(NOW, NOW, "failure"),
    ]
    assert mod.compute_build_failure_ratio(runs) == pytest.approx(0.25)


@BOTH
def test_build_failure_ratio_excludes_cancelled_unlike_change_failure_rate(mod):
    # The deliberate divergence from compute_change_failure_rate, which counts
    # cancelled as a failure. A cancelled run is usually a person changing their
    # mind, not the build breaking — the two metrics answer different questions.
    runs = [run(NOW, NOW, "success"), run(NOW, NOW, "cancelled")]

    assert mod.compute_build_failure_ratio(runs) == 0.0
    assert mod.compute_change_failure_rate(runs) == pytest.approx(50.0)


@BOTH
def test_build_failure_ratio_is_zero_when_nothing_ran(mod):
    assert mod.compute_build_failure_ratio([]) == 0.0


# ── the metric names are the contract with the collector ──────────────────────


@BOTH
def test_devex_gauge_names_match_the_collector(mod):
    # These strings are queried by packages/backend/src/modules/
    # engineeringIntelligence/prometheus.ts. Renaming one here silently blanks
    # the Developer Experience dimension rather than raising anything.
    assert set(mod.DEVEX_GAUGES) == {
        "devex_pr_cycle_time_hours",
        "devex_ci_duration_minutes",
        "devex_build_failure_ratio",
    }


# ── the drift guard ───────────────────────────────────────────────────────────


def test_both_exporters_compute_devex_identically():
    """The local and AWS exporters cannot share a module, so prove they agree.

    Each is deployed as a single-file ConfigMap, which is why the DevEx block is
    duplicated rather than imported. This is the only thing standing between that
    duplication and the silent divergence the Bronze/Silver/Gold scorecard
    already suffered three times over.
    """
    local, aws = MODULES["local"], MODULES["aws"]

    prs = [
        pr(NOW - timedelta(hours=9), NOW - timedelta(hours=4)),
        pr(NOW - timedelta(hours=6), None),
        pr(NOW - timedelta(days=5), NOW - timedelta(days=4)),
    ]
    runs = [
        run(NOW - timedelta(minutes=40), NOW - timedelta(minutes=25), "success"),
        run(NOW - timedelta(minutes=40), NOW - timedelta(minutes=5), "failure"),
        run(NOW - timedelta(minutes=40), NOW - timedelta(minutes=5), "cancelled"),
    ]

    assert local.compute_pr_cycle_time(prs, SINCE) == aws.compute_pr_cycle_time(prs, SINCE)
    assert local.compute_ci_duration(runs) == aws.compute_ci_duration(runs)
    assert local.compute_build_failure_ratio(runs) == aws.compute_build_failure_ratio(runs)
    assert local.DEVEX_GAUGES == aws.DEVEX_GAUGES


def test_pull_request_query_is_bounded():
    """One page, not every closed PR the repo has ever had.

    The pulls API has no `since` filter, so an unbounded walk would page through
    thousands of PRs every run and burn the rate limit for a mean that a recent
    sample already answers.
    """
    for mod in MODULES.values():
        source = Path(mod.__file__).read_text()
        assert "max_pages=1" in source
