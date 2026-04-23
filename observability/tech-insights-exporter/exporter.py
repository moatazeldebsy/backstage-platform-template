"""
Tech Insights Scorecard Exporter

Queries the Backstage catalog API, evaluates scorecard checks against each
Component entity, and publishes pass/fail counters to AWS CloudWatch.

Run as a CronJob (every 30 minutes) or locally for debugging.

Metrics published to CloudWatch namespace: IDP/Scorecards
  - idp_scorecard_check_pass   {service, team, check, level}
  - idp_scorecard_check_fail   {service, team, check, level}
  - idp_scorecard_level_bronze {service, team}  — 1 if all Bronze checks pass
  - idp_scorecard_level_silver {service, team}  — 1 if all Silver checks pass
  - idp_scorecard_level_gold   {service, team}  — 1 if all Gold checks pass

Environment variables:
  BACKSTAGE_URL       Backstage backend URL (default: http://localhost:7007)
  BACKSTAGE_TOKEN     Static token for Backstage auth (optional for guest mode)
  AWS_REGION          AWS region for CloudWatch (default: us-east-1)
  DRY_RUN             Set to "true" to print metrics without publishing (default: false)
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request
from dataclasses import dataclass, field
from typing import Any

import boto3

BACKSTAGE_URL = os.environ.get("BACKSTAGE_URL", "http://localhost:7007")
BACKSTAGE_TOKEN = os.environ.get("BACKSTAGE_TOKEN", "")
AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")
DRY_RUN = os.environ.get("DRY_RUN", "false").lower() == "true"
CW_NAMESPACE = "IDP/Scorecards"

# ── Scorecard check definitions ───────────────────────────────────────────────

CHECKS: dict[str, dict] = {
    # Bronze checks
    "has-owner": {
        "level": "bronze",
        "description": "Entity has a non-empty spec.owner",
        "evaluate": lambda e: bool((e.get("spec") or {}).get("owner")),
    },
    "has-techdocs": {
        "level": "bronze",
        "description": "Entity has backstage.io/techdocs-ref annotation",
        "evaluate": lambda e: bool(
            (e.get("metadata") or {}).get("annotations", {}).get(
                "backstage.io/techdocs-ref"
            )
        ),
    },
    "has-health-probes": {
        "level": "bronze",
        "description": "Entity has backstage.io/kubernetes-label-selector annotation",
        "evaluate": lambda e: bool(
            (e.get("metadata") or {}).get("annotations", {}).get(
                "backstage.io/kubernetes-label-selector"
            )
        ),
    },
    # Silver checks
    "has-api-definition": {
        "level": "silver",
        "description": "Entity declares providesApis or consumesApis",
        "evaluate": lambda e: bool(
            (e.get("spec") or {}).get("providesApis")
            or (e.get("spec") or {}).get("consumesApis")
        ),
    },
    "has-runbook-url": {
        "level": "silver",
        "description": "Entity has backstage.io/runbook-url annotation",
        "evaluate": lambda e: bool(
            (e.get("metadata") or {}).get("annotations", {}).get(
                "backstage.io/runbook-url"
            )
        ),
    },
    # Gold checks
    "uses-pinned-image-tag": {
        "level": "gold",
        "description": "Entity tags do not include 'latest'",
        "evaluate": lambda e: "latest"
        not in ((e.get("metadata") or {}).get("tags") or []),
    },
}

BRONZE_CHECKS = {k for k, v in CHECKS.items() if v["level"] == "bronze"}
SILVER_CHECKS = {k for k, v in CHECKS.items() if v["level"] == "silver"}
GOLD_CHECKS = {k for k, v in CHECKS.items() if v["level"] == "gold"}


# ── Fetch entities from Backstage ─────────────────────────────────────────────

def fetch_components() -> list[dict[str, Any]]:
    url = f"{BACKSTAGE_URL}/api/catalog/entities?filter=kind=Component"
    headers = {"Content-Type": "application/json"}
    if BACKSTAGE_TOKEN:
        headers["Authorization"] = f"Bearer {BACKSTAGE_TOKEN}"

    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())


# ── Evaluate checks ───────────────────────────────────────────────────────────

@dataclass
class EntityResult:
    name: str
    team: str
    check_results: dict[str, bool] = field(default_factory=dict)

    @property
    def bronze_pass(self) -> bool:
        return all(self.check_results.get(c, False) for c in BRONZE_CHECKS)

    @property
    def silver_pass(self) -> bool:
        return self.bronze_pass and all(
            self.check_results.get(c, False) for c in SILVER_CHECKS
        )

    @property
    def gold_pass(self) -> bool:
        return self.silver_pass and all(
            self.check_results.get(c, False) for c in GOLD_CHECKS
        )


def evaluate(entity: dict[str, Any]) -> EntityResult:
    name = (entity.get("metadata") or {}).get("name", "unknown")
    owner = str((entity.get("spec") or {}).get("owner", "unknown"))
    team = owner.split("/")[-1] if "/" in owner else owner

    result = EntityResult(name=name, team=team)
    for check_id, check in CHECKS.items():
        try:
            result.check_results[check_id] = bool(check["evaluate"](entity))
        except Exception:
            result.check_results[check_id] = False

    return result


# ── Publish to CloudWatch ──────────────────────────────────────────────────────

def publish_metrics(results: list[EntityResult]) -> None:
    if DRY_RUN:
        for r in results:
            print(f"[DRY_RUN] {r.name} team={r.team} bronze={r.bronze_pass} silver={r.silver_pass} gold={r.gold_pass}")
            for check_id, passed in r.check_results.items():
                level = CHECKS[check_id]["level"]
                print(f"  {check_id} ({level}): {'PASS' if passed else 'FAIL'}")
        return

    cw = boto3.client("cloudwatch", region_name=AWS_REGION)
    metric_data: list[dict] = []

    for r in results:
        for check_id, passed in r.check_results.items():
            level = CHECKS[check_id]["level"]
            dimensions = [
                {"Name": "Service", "Value": r.name},
                {"Name": "Team", "Value": r.team},
                {"Name": "Check", "Value": check_id},
                {"Name": "Level", "Value": level},
            ]
            metric_data.append({
                "MetricName": "CheckPassed",
                "Dimensions": dimensions,
                "Value": 1.0 if passed else 0.0,
                "Unit": "Count",
            })

        for level_name, level_pass in [
            ("bronze", r.bronze_pass),
            ("silver", r.silver_pass),
            ("gold", r.gold_pass),
        ]:
            metric_data.append({
                "MetricName": f"MaturityLevel{level_name.capitalize()}",
                "Dimensions": [
                    {"Name": "Service", "Value": r.name},
                    {"Name": "Team", "Value": r.team},
                ],
                "Value": 1.0 if level_pass else 0.0,
                "Unit": "Count",
            })

        # CloudWatch limits 1000 metrics per PutMetricData call; batch in chunks of 20
        if len(metric_data) >= 20:
            cw.put_metric_data(Namespace=CW_NAMESPACE, MetricData=metric_data)
            metric_data = []

    if metric_data:
        cw.put_metric_data(Namespace=CW_NAMESPACE, MetricData=metric_data)

    print(f"Published scorecard metrics for {len(results)} entities to CloudWatch namespace {CW_NAMESPACE!r}")


# ── Entry point ───────────────────────────────────────────────────────────────

def main() -> None:
    print(f"Fetching catalog entities from {BACKSTAGE_URL}...")
    try:
        entities = fetch_components()
    except Exception as exc:
        print(f"ERROR: Failed to fetch catalog entities: {exc}", file=sys.stderr)
        sys.exit(1)

    print(f"Evaluating scorecard checks for {len(entities)} Component entities...")
    results = [evaluate(e) for e in entities]

    publish_metrics(results)

    # Print summary
    bronze_count = sum(1 for r in results if r.bronze_pass)
    silver_count = sum(1 for r in results if r.silver_pass)
    gold_count = sum(1 for r in results if r.gold_pass)
    print(f"Summary: Bronze={bronze_count}/{len(results)} Silver={silver_count}/{len(results)} Gold={gold_count}/{len(results)}")


if __name__ == "__main__":
    main()
