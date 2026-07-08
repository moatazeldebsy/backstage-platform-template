"""Skips tests listed in flaky-quarantine.yaml instead of letting them fail
the build non-deterministically. See docs/flaky-test-quarantine.md.

The quarantine list is synced automatically by the platform's
flaky-test-quarantine-sync CronJob, which opens a PR here whenever
observability/flaky-test-exporter classifies a test as flaky (passed AND
failed) across the CI run window. A quarantined test still runs — it's
marked xfail (strict=False), not skipped outright — so it keeps reporting
pass/fail in the JUnit output the exporter reads, but can't turn the build red.
"""
from pathlib import Path

import pytest
import yaml

_QUARANTINE_FILE = Path(__file__).parent.parent / "flaky-quarantine.yaml"


def _quarantined_test_ids() -> set[str]:
    if not _QUARANTINE_FILE.exists():
        return set()
    doc = yaml.safe_load(_QUARANTINE_FILE.read_text()) or {}
    return {entry["test"] for entry in doc.get("quarantined", [])}


def pytest_collection_modifyitems(items: list[pytest.Item]) -> None:
    quarantined = _quarantined_test_ids()
    if not quarantined:
        return
    for item in items:
        # test_id format matches exporter.py's "<classname>/<name>" convention.
        test_id = f"{item.cls.__name__}/{item.name}" if item.cls else item.name
        if test_id in quarantined or item.nodeid.split("::")[-1] in quarantined:
            item.add_marker(pytest.mark.xfail(
                reason="quarantined as flaky — see flaky-quarantine.yaml",
                strict=False,
            ))
