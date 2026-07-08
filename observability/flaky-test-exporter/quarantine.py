#!/usr/bin/env python3
"""
Flaky-Test Quarantine Sync

Acts on the classification that `exporter.py` already computes: for every
service with a test that has been flaky (passed AND failed) across the full
observed window — not just a single bad run — opens or updates a PR against
that service's own repo adding the test to `flaky-quarantine.yaml` at the repo
root. Tests that are no longer flaky are proposed for removal in the same PR.

This is the "act on it" half of flaky-test detection: `exporter.py` only
classifies and reports to Prometheus. Nothing consumed that signal in CI until
this script existed. See docs/flaky-test-quarantine.md for the full mechanism,
including how each language's golden-path CI is expected to read
`flaky-quarantine.yaml` and skip the listed tests.

Runs as a Kubernetes CronJob, once a day (deliberately much less frequent than
the 30-minute metrics scrape in exporter.py, to avoid opening a new PR on every
tick — see idempotency note on `_upsert_pr` below).

Environment variables
  BACKSTAGE_URL   — Backstage base URL (catalog source of truth)
  BACKSTAGE_TOKEN — Backstage service token
  GITHUB_TOKEN    — PAT with `repo` scope (same token exporter.py uses)
  WINDOW_SIZE     — number of recent workflow runs per repo (default: 10)
  MIN_RUNS        — minimum runs observed before quarantine acts (default: WINDOW_SIZE,
                     i.e. only act once a full window has been observed)
"""
import logging
import os
import sys
from datetime import datetime, timezone

import requests
import yaml

from exporter import (  # reuse the exact same classification logic
    GITHUB_HEADERS,
    WINDOW_SIZE,
    ServiceFlakiness,
    collect,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

MIN_RUNS = int(os.environ.get("MIN_RUNS", str(WINDOW_SIZE)))
QUARANTINE_PATH = "flaky-quarantine.yaml"
QUARANTINE_BRANCH = "flaky-quarantine/auto-update"


def _get_file(repo: str, path: str) -> tuple[str | None, str | None]:
    """Returns (content, sha) from the default branch, or (None, None) if missing."""
    url = f"https://api.github.com/repos/{repo}/contents/{path}"
    resp = requests.get(url, headers=GITHUB_HEADERS, timeout=30)
    if resp.status_code == 404:
        return None, None
    resp.raise_for_status()
    import base64
    data = resp.json()
    content = base64.b64decode(data["content"]).decode("utf-8")
    return content, data["sha"]


def _default_branch(repo: str) -> str:
    resp = requests.get(f"https://api.github.com/repos/{repo}", headers=GITHUB_HEADERS, timeout=30)
    resp.raise_for_status()
    return resp.json()["default_branch"]


def _branch_sha(repo: str, branch: str) -> str | None:
    resp = requests.get(
        f"https://api.github.com/repos/{repo}/git/ref/heads/{branch}",
        headers=GITHUB_HEADERS, timeout=30,
    )
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return resp.json()["object"]["sha"]


def build_quarantine_doc(sf: ServiceFlakiness, existing: dict) -> tuple[dict, bool]:
    """Merge current flaky classification into the existing quarantine doc.
    Returns (new_doc, changed)."""
    entries = {e["test"]: e for e in existing.get("quarantined", [])}
    changed = False
    today = datetime.now(timezone.utc).date().isoformat()

    flaky_ids = {tr.test_id for tr in sf.flaky_tests}
    for tr in sf.flaky_tests:
        if tr.test_id not in entries:
            entries[tr.test_id] = {
                "test": tr.test_id,
                "suite": tr.suite,
                "flakiness_ratio": round(tr.flakiness_ratio, 4),
                "first_detected": today,
                "reason": "auto-quarantined: flaky (pass and fail) across the full observed window",
            }
            changed = True
        else:
            # Refresh the ratio so reviewers can see it's still active.
            if entries[tr.test_id].get("flakiness_ratio") != round(tr.flakiness_ratio, 4):
                entries[tr.test_id]["flakiness_ratio"] = round(tr.flakiness_ratio, 4)
                changed = True

    # Propose removing entries that are no longer flaky (stable in the full window).
    for test_id in list(entries.keys()):
        if test_id not in flaky_ids and sf.runs_observed >= MIN_RUNS:
            del entries[test_id]
            changed = True

    return {"quarantined": sorted(entries.values(), key=lambda e: e["test"])}, changed


def sync_service(sf: ServiceFlakiness) -> None:
    if sf.runs_observed < MIN_RUNS:
        log.info("%s — only %d/%d runs observed, skipping quarantine sync", sf.service, sf.runs_observed, MIN_RUNS)
        return

    existing_raw, sha = _get_file(sf.repo, QUARANTINE_PATH)
    existing = yaml.safe_load(existing_raw) if existing_raw else {}
    new_doc, changed = build_quarantine_doc(sf, existing or {})

    if not changed:
        log.info("%s — quarantine list already up to date (%d entries)", sf.service, len(new_doc["quarantined"]))
        return

    base_branch = _default_branch(sf.repo)
    base_sha = _branch_sha(sf.repo, base_branch)
    existing_branch_sha = _branch_sha(sf.repo, QUARANTINE_BRANCH)

    if existing_branch_sha is None:
        requests.post(
            f"https://api.github.com/repos/{sf.repo}/git/refs",
            headers=GITHUB_HEADERS, timeout=30,
            json={"ref": f"refs/heads/{QUARANTINE_BRANCH}", "sha": base_sha},
        ).raise_for_status()

    new_content = yaml.safe_dump(new_doc, sort_keys=False)
    import base64
    put_resp = requests.put(
        f"https://api.github.com/repos/{sf.repo}/contents/{QUARANTINE_PATH}",
        headers=GITHUB_HEADERS, timeout=30,
        json={
            "message": f"chore(test): sync flaky-test quarantine ({len(new_doc['quarantined'])} entries)",
            "content": base64.b64encode(new_content.encode("utf-8")).decode("ascii"),
            "branch": QUARANTINE_BRANCH,
            **({"sha": sha} if existing_branch_sha and sha else {}),
        },
    )
    put_resp.raise_for_status()

    # Open the PR if one doesn't already exist for this branch.
    existing_prs = requests.get(
        f"https://api.github.com/repos/{sf.repo}/pulls",
        headers=GITHUB_HEADERS, timeout=30,
        params={"head": f"{sf.repo.split('/')[0]}:{QUARANTINE_BRANCH}", "state": "open"},
    )
    existing_prs.raise_for_status()
    if existing_prs.json():
        log.info("%s — quarantine PR already open, pushed new commit to it", sf.service)
        return

    body_lines = [
        "## Flaky Test Quarantine Sync",
        "",
        f"Auto-generated by `flaky-test-exporter`'s quarantine sync job. "
        f"Based on the last {sf.runs_observed} CI runs (window size {WINDOW_SIZE}).",
        "",
        "| Test | Suite | Flakiness Ratio |",
        "|------|-------|-----------------|",
    ]
    for e in new_doc["quarantined"]:
        body_lines.append(f"| `{e['test']}` | `{e['suite']}` | {e['flakiness_ratio']:.0%} |")
    body_lines += [
        "",
        "Each language's golden-path CI reads `flaky-quarantine.yaml` and skips these tests "
        "rather than letting them fail the build non-deterministically. See "
        "[docs/flaky-test-quarantine.md](https://github.com/moatazeldebsy/backstage-platform-template/blob/main/docs/flaky-test-quarantine.md) "
        "for the mechanism and how to un-quarantine a test once it's fixed.",
        "",
        "_A quarantined test still runs — it's just not allowed to fail the build. "
        "Fix it and remove its entry here, don't let it live in quarantine forever._",
    ]
    pr_resp = requests.post(
        f"https://api.github.com/repos/{sf.repo}/pulls",
        headers=GITHUB_HEADERS, timeout=30,
        json={
            "title": f"chore(test): sync flaky-test quarantine ({len(new_doc['quarantined'])} entries)",
            "head": QUARANTINE_BRANCH,
            "base": base_branch,
            "body": "\n".join(body_lines),
        },
    )
    pr_resp.raise_for_status()
    log.info("%s — opened quarantine PR: %s", sf.service, pr_resp.json().get("html_url"))


def main() -> None:
    if not GITHUB_HEADERS.get("Authorization"):
        log.error("GITHUB_TOKEN is required")
        sys.exit(1)

    services = collect()
    for sf in services:
        try:
            sync_service(sf)
        except Exception as e:
            log.error("%s — quarantine sync failed: %s", sf.service, e)


if __name__ == "__main__":
    main()
