#!/usr/bin/env python3
"""Render a postmortem draft from a resolved incident issue.

The `incident:needs-postmortem` label has been applied by agent-event-router
since the incident work landed, and consumed by absolutely nothing. This is what
consumes it.

Deliberately deterministic: it fills in the facts the platform already knows —
the identifiers, the timeline it can reconstruct from the issue and its comments,
and the MTTR arithmetic — and leaves every field that requires human judgement
blank. It does not attempt a narrative. An AI-drafted root cause is a reasonable
follow-up, but a plausible-sounding wrong root cause in a postmortem is worse
than an empty heading.

Usage:
    render-postmortem.py --repo owner/repo --issue 123 [--out docs/postmortems]

Reads GITHUB_TOKEN from the environment.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

MARKER_RE = re.compile(r"<!--\s*idp-incident:\s*(\{.*?\})\s*-->", re.S)
API = "https://api.github.com"


def api_get(path: str, token: str) -> object:
    req = urllib.request.Request(
        f"{API}{path}",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "idp-postmortem-renderer",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def parse_marker(body: str | None) -> dict:
    """Structured incident state, or {} for a pre-marker issue."""
    if not body:
        return {}
    m = MARKER_RE.search(body)
    if not m:
        return {}
    try:
        return json.loads(m.group(1))
    except json.JSONDecodeError:
        # A hand-edited issue body should degrade to a sparser draft, not crash
        # the workflow and leave the label dangling.
        return {}


def parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def fmt(dt: datetime | None) -> str:
    return dt.strftime("%Y-%m-%d %H:%M UTC") if dt else "_unknown_"


def slugify(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", (text or "incident").lower()).strip("-")
    return (slug or "incident")[:60]


def build_timeline(marker: dict, issue: dict, comments: list[dict]) -> list[tuple[str, str]]:
    """Everything the platform can state as fact. Anything else is for a human."""
    rows: list[tuple[str, str]] = []
    started = parse_iso(marker.get("startsAt")) or parse_iso(issue.get("created_at"))
    if started:
        rows.append((started.strftime("%H:%M"), f"Alert fired — `{marker.get('incidentId', 'incident')}` opened as issue #{issue['number']}"))
    for c in comments:
        when = parse_iso(c.get("created_at"))
        author = (c.get("user") or {}).get("login", "unknown")
        first_line = (c.get("body") or "").strip().splitlines()[0] if c.get("body") else ""
        if len(first_line) > 110:
            first_line = first_line[:107] + "..."
        if when:
            rows.append((when.strftime("%H:%M"), f"@{author}: {first_line}"))
    ended = parse_iso(marker.get("endsAt")) or parse_iso(issue.get("closed_at"))
    if ended:
        rows.append((ended.strftime("%H:%M"), "Alert resolved"))
    return rows


def render(marker: dict, issue: dict, comments: list[dict], repo: str) -> str:
    started = parse_iso(marker.get("startsAt")) or parse_iso(issue.get("created_at"))
    ended = parse_iso(marker.get("endsAt")) or parse_iso(issue.get("closed_at"))
    duration = marker.get("durationMinutes")
    if duration is None and started and ended:
        duration = max(0, int((ended - started).total_seconds() // 60))

    inc_id = marker.get("incidentId") or f"INC-{issue['number']}"
    severity = marker.get("severity") or "_unknown_"
    service = marker.get("service") or "_unknown_"
    issue_url = issue.get("html_url", "")
    pd_url = marker.get("pagerdutyUrl")

    timeline = build_timeline(marker, issue, comments)
    timeline_rows = "\n".join(f"| {t} | {e} |" for t, e in timeline) or "| HH:MM | _add events_ |"

    return f"""# Post-Mortem: {issue.get('title', inc_id)}

> **Draft** — generated from incident issue [#{issue['number']}]({issue_url}) when it was
> labelled `incident:needs-postmortem`. The identifiers, timeline and MTTR below are
> filled in from the incident record; **every section marked _TODO_ needs a human**.
> Keep it blameless: systems, processes and conditions, not individuals.

---

## Incident Summary

| Field | Value |
|-------|-------|
| **Incident ID** | {inc_id} |
| **Severity** | {severity} |
| **Service(s) affected** | {service} |
| **Start time** | {fmt(started)} |
| **End time** | {fmt(ended)} |
| **Total duration** | {f'{duration} minutes' if duration is not None else '_unknown_'} |
| **Incident commander** | _TODO_ |
| **Scribe** | _TODO_ |
| **Reviewers** | _TODO_ |

---

## Impact

_TODO — what was broken, for how many users, in which regions._

- **Affected users / requests:** _TODO_
- **Error rate peak:** _TODO_
- **Data loss / corruption:** _TODO_
- **SLO breach:** _TODO_

---

## Timeline

_Reconstructed from the incident issue and its comments. Add anything that
happened outside GitHub — Slack decisions, manual mitigations, the moment
somebody understood the cause._

| Time (UTC) | Event |
|------------|-------|
{timeline_rows}

---

## Root Cause

_TODO — the condition that made this possible, not the trigger that exposed it._

---

## Contributing Factors

_TODO_

---

## Detection

_TODO — how was it noticed, and how long did that take? Was the alert the first
signal, or did someone notice before it fired?_

---

## Response

_TODO_

---

## Remediation Actions

| Action | Owner | Issue | Due |
|--------|-------|-------|-----|
| _TODO_ | _TODO_ | _TODO_ | _TODO_ |

---

## What Went Well

_TODO_

---

## Lessons Learned

_TODO_

---

## Metrics

| Metric | Value |
|--------|-------|
| Time to detect (TTD) | _TODO_ |
| Time to mitigate (TTM) | _TODO_ |
| Time to resolve (TTR / MTTR) | {f'{duration} min' if duration is not None else '_TODO_'} |
| Error budget consumed | _TODO_ |
| Customers impacted | _TODO_ |

---

## References

- Incident record: {issue_url}
{f'- PagerDuty incident: {pd_url}' if pd_url else '- PagerDuty incident: _n/a_'}
- Repository: https://github.com/{repo}
- Runbook used: _TODO_
- Relevant PR / commit: _TODO_
"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True, help="owner/repo")
    ap.add_argument("--issue", required=True, type=int)
    ap.add_argument("--out", default="docs/postmortems")
    args = ap.parse_args()

    token = os.environ.get("GITHUB_TOKEN", "")
    if not token:
        print("GITHUB_TOKEN is not set", file=sys.stderr)
        return 2

    try:
        issue = api_get(f"/repos/{args.repo}/issues/{args.issue}", token)
        comments = api_get(f"/repos/{args.repo}/issues/{args.issue}/comments?per_page=100", token)
    except urllib.error.HTTPError as e:
        print(f"GitHub API error: HTTP {e.code}", file=sys.stderr)
        return 1

    marker = parse_marker(issue.get("body"))
    if not marker:
        print(
            f"issue #{args.issue} has no idp-incident marker — rendering a sparser draft "
            "from the issue metadata alone",
            file=sys.stderr,
        )

    started = parse_iso(marker.get("startsAt")) or parse_iso(issue.get("created_at")) or datetime.now(timezone.utc)
    inc_id = marker.get("incidentId") or f"INC-{issue['number']}"
    filename = f"{inc_id}-{slugify(marker.get('service') or issue.get('title', ''))}.md"

    os.makedirs(args.out, exist_ok=True)
    path = os.path.join(args.out, filename)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(render(marker, issue, comments, args.repo))

    print(f"wrote {path}")
    # Consumed by the workflow for the branch name, PR title and issue comment.
    if gh_out := os.environ.get("GITHUB_OUTPUT"):
        with open(gh_out, "a", encoding="utf-8") as fh:
            fh.write(f"path={path}\n")
            fh.write(f"incident_id={inc_id}\n")
            fh.write(f"started={started.isoformat()}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
