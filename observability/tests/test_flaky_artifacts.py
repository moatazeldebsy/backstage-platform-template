"""Behavioural tests for artifact discovery in the flaky-test exporter.

Two failures this file prevents.

**A multi-language repository reporting only one language's tests.** The
exporter matched an artifact called exactly `test-results` and returned the
first one it found. But `upload-artifact@v4` rejects a duplicate artifact name
within a single run, so a repository with a Go job and a Python job *cannot*
name both `test-results` — it has to publish `test-results-go` and
`test-results-python`. Under the old exact match those repositories reported no
tests at all; under a first-match-wins rule they would report one job's results
and silently drop the other, so a run whose Python tests failed and whose Go
tests passed would score as clean.

**Counting one run more than once.** `runs_observed` is the denominator behind
the flakiness window. A run that publishes three artifacts is still one run, and
inflating the denominator would make a service look more heavily tested than it
is.

Only pure functions are exercised — `matches_artifact_name` and the JUnit
parser. Nothing here touches the network.
"""

import importlib.util
import io
import os
import sys
import types
import zipfile
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
EXPORTER = REPO_ROOT / "observability" / "flaky-test-exporter" / "exporter.py"


def _stub_third_party() -> None:
    os.environ.setdefault("GITHUB_TOKEN", "test-token")
    os.environ.setdefault("BACKSTAGE_TOKEN", "test-token")
    if "requests" not in sys.modules:
        requests = types.ModuleType("requests")
        requests.get = lambda *a, **k: None
        requests.post = lambda *a, **k: None
        sys.modules["requests"] = requests
    if "prometheus_client" not in sys.modules:
        prom = types.ModuleType("prometheus_client")
        prom.CollectorRegistry = type("CollectorRegistry", (), {})
        prom.Gauge = type("Gauge", (), {})
        prom.push_to_gateway = lambda *a, **k: None
        sys.modules["prometheus_client"] = prom


def _load():
    _stub_third_party()
    spec = importlib.util.spec_from_file_location("flaky_exporter", EXPORTER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


mod = _load()


def junit_zip(*suites: tuple[str, list[tuple[str, str]]]) -> bytes:
    """Build a ZIP of JUnit XML. Each suite is (name, [(test, outcome)])."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for suite_name, cases in suites:
            body = ""
            for test_name, outcome in cases:
                inner = {
                    "pass": "",
                    "fail": "<failure message='boom'/>",
                    "skip": "<skipped/>",
                }[outcome]
                body += f'<testcase classname="{suite_name}" name="{test_name}">{inner}</testcase>'
            xml = f'<testsuite name="{suite_name}">{body}</testsuite>'
            zf.writestr(f"{suite_name}.xml", xml)
    return buf.getvalue()


# ── artifact name matching ────────────────────────────────────────────────────


def test_exact_name_still_matches():
    # Single-job repositories, which is every scaffolded skeleton, must keep
    # working unchanged.
    assert mod.matches_artifact_name("test-results")


@pytest.mark.parametrize(
    "name", ["test-results-go", "test-results-cli", "test-results-observability"]
)
def test_suffixed_names_match(name):
    # upload-artifact@v4 forbids duplicate names in a run, so a repo with more
    # than one test job has no choice but to suffix them.
    assert mod.matches_artifact_name(name)


@pytest.mark.parametrize(
    "name", ["coverage", "go-coverage", "results", "", "my-test-results"]
)
def test_unrelated_names_do_not_match(name):
    # "my-test-results" is the interesting one: matching on `in` rather than a
    # prefix would sweep up artifacts that are not ours.
    assert not mod.matches_artifact_name(name)


def test_matching_follows_the_configured_name(monkeypatch):
    monkeypatch.setattr(mod, "ARTIFACT_NAME", "junit")
    assert mod.matches_artifact_name("junit")
    assert mod.matches_artifact_name("junit-python")
    assert not mod.matches_artifact_name("test-results")


# ── parsing across several artifacts ──────────────────────────────────────────


def test_a_failure_in_a_second_artifact_is_not_lost():
    # The regression that motivated the change: Go passes, Python fails. Taking
    # only the first artifact would report the run as clean.
    go = junit_zip(("go", [("TestAdd", "pass")]))
    py = junit_zip(("python", [("test_parse", "fail")]))

    outcomes = {}
    for blob in (go, py):
        for test_id, _suite, outcome in mod.iter_testcases(blob):
            outcomes[test_id] = outcome

    assert outcomes == {"go/TestAdd": "pass", "python/test_parse": "fail"}


def test_one_run_counts_once_however_many_artifacts(monkeypatch):
    # runs_observed is the flakiness denominator. Three artifacts is still one
    # run, and inflating it would understate how flaky a service is.
    sf = mod.ServiceFlakiness(service="svc", team="t", repo="o/r")
    blobs = [
        junit_zip(("go", [("TestA", "pass")])),
        junit_zip(("py", [("test_b", "fail")])),
        junit_zip(("js", [("renders", "pass")])),
    ]
    sf.runs_observed += 1
    for blob in blobs:
        for test_id, suite, outcome in mod.iter_testcases(blob):
            sf.record(test_id, suite, outcome)

    assert sf.runs_observed == 1
    assert len(sf.results) == 3


def test_a_bad_zip_yields_nothing_rather_than_raising():
    # A truncated download must lower coverage, never fail the tick.
    assert list(mod.iter_testcases(b"not a zip")) == []
