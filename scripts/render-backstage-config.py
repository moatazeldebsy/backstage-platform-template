#!/usr/bin/env python3
"""Render app-config.aws.yaml for the cluster, preserving live substitutions.

`apply_backstage_configmaps` used to apply the repo file verbatim. That is correct
on a cold bootstrap, because the substitutions happen immediately afterwards. It
is wrong on every warm re-run, because three of the six placeholders and the whole
AI enabled-state are owned by `bootstrap-ai.sh`, which only runs with `--with-ai`.

So `./scripts/bootstrap.sh` against a cluster that already has the AI stack would:

  * reset KAGENT_ALB_URL / MLFLOW_ALB_URL / LANGFUSE_ALB_URL to literal
    placeholders, breaking those links,
  * flip `aiStack.enabled` back to false and re-disable the AI pages and nav
    items, hiding features that are still installed and running,
  * and reset BACKSTAGE/ARGOCD/GRAFANA too, until the later sed re-derives them.

Observed against a live cluster on 2026-08-14.

This carries the resolved values forward from the ConfigMap that is already in the
cluster. Anything the current run *does* re-derive still overwrites afterwards, so
cold bootstraps are unaffected — on a cold run there is no live ConfigMap and this
is a straight passthrough.

Usage:
    render-backstage-config.py --repo-file backstage/app-config.aws.yaml \
                               [--live-file <dump of the live ConfigMap>]

Writes the rendered config to stdout.
"""
from __future__ import annotations

import argparse
import re
import sys

# Placeholders bootstrap.sh / bootstrap-ai.sh substitute after the ConfigMap is
# applied. Each is recovered from the live copy by matching the key it sits on,
# so no assumption is made about hostname shape.
PLACEHOLDERS = [
    "BACKSTAGE_ALB_URL",
    "ARGOCD_ALB_URL",
    "GRAFANA_ALB_URL",
    "KAGENT_ALB_URL",
    "MLFLOW_ALB_URL",
    "LANGFUSE_ALB_URL",
]


def carry_forward_placeholders(repo: str, live: str) -> tuple[str, list[str]]:
    """Replace each placeholder with the value the live ConfigMap already has.

    Works by locating the placeholder in the repo file, taking everything before
    it on that line as a key prefix, then finding the same prefix in the live
    file and lifting the value that follows.
    """
    carried: list[str] = []
    for ph in PLACEHOLDERS:
        for line in repo.splitlines():
            # Comments mention these placeholders too, and a comment prefix
            # matches nothing in the live file. Skipping them matters: the first
            # mention of BACKSTAGE_ALB_URL in the file is a comment, so stopping
            # at the first hit meant app.baseUrl was never carried forward — the
            # one substitution whose loss breaks GitHub sign-in.
            if line.lstrip().startswith("#"):
                continue
            idx = line.find(ph)
            if idx == -1:
                continue
            prefix = line[:idx]
            if not prefix.strip():
                continue
            # Same prefix in the live file, followed by anything that is not
            # still the placeholder itself.
            m = re.search(rf"^{re.escape(prefix)}(\S+)\s*$", live, re.M)
            if m and ph not in m.group(1):
                repo = repo.replace(ph, m.group(1))
                carried.append(f"{ph}={m.group(1)}")
                break
            # No resolvable value on this line — keep looking; the same
            # placeholder usually appears on several keys.
    return repo, carried


def carry_forward_ai_state(repo: str, live: str) -> tuple[str, list[str]]:
    """Preserve `aiStack.enabled` and the AI extension disable flags.

    bootstrap-ai.sh flips these on when it installs the AI layer. The repo ships
    them off, because AI is opt-in — so re-applying the repo file on a cluster
    that has the layer installed hides features that are still running.
    """
    notes: list[str] = []

    live_ai = re.search(r"^aiStack:\n(?:\s+.*\n)*?\s+enabled:\s*(\S+)", live, re.M)
    repo_ai = re.search(r"^(aiStack:\n(?:\s+.*\n)*?\s+enabled:\s*)(\S+)", repo, re.M)
    if live_ai and repo_ai and live_ai.group(1) != repo_ai.group(2):
        repo = repo[: repo_ai.start(2)] + live_ai.group(1) + repo[repo_ai.end(2) :]
        notes.append(f"aiStack.enabled={live_ai.group(1)}")

    # The extensions block is a list of `- <id>:\n    disabled: <bool>` entries.
    # Preserved per id, so an entry the repo adds which live has never seen keeps
    # the repo's value rather than being silently dropped.
    entry_re = re.compile(r"^(?P<lead>\s+-\s+)(?P<id>\S+):\n(?P<ind>\s+)disabled:\s*(?P<val>\S+)\s*$", re.M)
    live_flags = {m.group("id"): m.group("val") for m in entry_re.finditer(live)}

    if live_flags:
        def swap(m: re.Match) -> str:
            ext_id, current = m.group("id"), m.group("val")
            wanted = live_flags.get(ext_id, current)
            if wanted != current:
                notes.append(f"{ext_id}.disabled={wanted}")
            return f"{m.group('lead')}{ext_id}:\n{m.group('ind')}disabled: {wanted}"

        repo = entry_re.sub(swap, repo)

    return repo, notes


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo-file", required=True)
    ap.add_argument("--live-file", help="Dump of the live ConfigMap; omit on a cold bootstrap")
    args = ap.parse_args()

    repo = open(args.repo_file, encoding="utf-8").read()

    live = ""
    if args.live_file:
        try:
            live = open(args.live_file, encoding="utf-8").read()
        except OSError:
            live = ""

    if not live.strip():
        # Cold bootstrap: nothing to preserve, straight passthrough.
        sys.stdout.write(repo)
        return 0

    repo, carried = carry_forward_placeholders(repo, live)
    repo, notes = carry_forward_ai_state(repo, live)

    for item in carried + notes:
        print(f"  carried forward: {item}", file=sys.stderr)

    sys.stdout.write(repo)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
