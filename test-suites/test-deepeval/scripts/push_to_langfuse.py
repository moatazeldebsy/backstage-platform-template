#!/usr/bin/env python3
"""Push DeepEval metric results into Langfuse as traces + scores.

Turns each eval run into a point on a trend line: one Langfuse trace per test,
carrying a NUMERIC score for the metric value and a BOOLEAN score for pass/fail,
tagged with the commit and branch.

Reads results/metrics.jsonl, written by the assert_test wrapper in
tests/conftest.py.

Reachability, which is the catch: a GitHub-hosted runner cannot reach
langfuse-web.ml-platform.svc.cluster.local, and the local instance sits behind
langfuse.idp.local on a Kind cluster. This only does anything against a publicly
reachable Langfuse — Langfuse Cloud, or the AWS ALB. It exits 0 and does nothing
when LANGFUSE_HOST is unset, so the eval job stays green either way.

Usage:
    LANGFUSE_HOST=... LANGFUSE_PUBLIC_KEY=... LANGFUSE_SECRET_KEY=... \
        python scripts/push_to_langfuse.py
"""

from __future__ import annotations

import json
import os
import pathlib
import sys

RESULTS = pathlib.Path(os.environ.get("EVAL_RESULTS_FILE", "results/metrics.jsonl"))
DATASET = os.environ.get("LANGFUSE_DATASET", "idp-agent-evals")


def main() -> int:
    host = os.environ.get("LANGFUSE_HOST")
    pk = os.environ.get("LANGFUSE_PUBLIC_KEY")
    sk = os.environ.get("LANGFUSE_SECRET_KEY")

    if not (host and pk and sk):
        print("Langfuse is not configured (LANGFUSE_HOST / _PUBLIC_KEY / _SECRET_KEY) — skipping push.")
        return 0

    if not RESULTS.exists():
        print(f"No {RESULTS} — nothing to push. (Did the eval suite run?)")
        return 0

    try:
        from langfuse import Langfuse
    except ImportError:
        print("The langfuse SDK is not installed — skipping push.", file=sys.stderr)
        return 0

    client = Langfuse(public_key=pk, secret_key=sk, host=host)

    rows = [json.loads(line) for line in RESULTS.read_text().splitlines() if line.strip()]
    if not rows:
        print("metrics.jsonl is empty — nothing to push.")
        return 0

    commit = os.environ.get("GITHUB_SHA", "local")
    ref = os.environ.get("GITHUB_REF_NAME", "local")

    pushed = 0
    for r in rows:
        # One trace per (test, metric) so each score is independently filterable.
        with client.start_as_current_span(name=r["test"]) as span:
            span.update_trace(
                name=r["test"],
                input=r.get("input"),
                output=r.get("output"),
                tags=["deepeval", "ci", ref],
                metadata={
                    "commit": commit,
                    "metric": r["metric"],
                    "threshold": r.get("threshold"),
                },
            )
            score = r.get("score")
            if score is not None:
                span.score_trace(
                    name=r["metric"],
                    value=float(score),
                    comment=r.get("reason"),
                    data_type="NUMERIC",
                )
            span.score_trace(
                name=f"{r['metric']}_pass",
                value=1 if r.get("success") else 0,
                data_type="BOOLEAN",
            )
            pushed += 1

    client.flush()
    print(f"Pushed {pushed} eval result(s) to {host} (dataset tag: {DATASET}).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
