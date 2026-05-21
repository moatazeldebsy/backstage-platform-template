#!/usr/bin/env python3
"""
Tech Insights Scorecard Exporter
Reads Bronze/Silver/Gold scorecard results from the Backstage Tech Insights API
and publishes them as Prometheus metrics.

Runs as a Kubernetes CronJob every 15 minutes.

Environment variables:
  BACKSTAGE_URL        — Backstage base URL (e.g. http://backstage.idp.local)
  BACKSTAGE_TOKEN      — Static token from app-config.yaml backend.auth
  PUSHGATEWAY_URL      — Prometheus Pushgateway URL (local mode)
  CLOUDWATCH_NS        — CloudWatch namespace (AWS mode, default: IDP/TechInsights)
  AWS_REGION           — AWS region (AWS mode)
  MODE                 — "pushgateway" (local) or "cloudwatch" (AWS), default: pushgateway
"""
import os
import sys
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

BACKSTAGE_URL   = os.environ.get("BACKSTAGE_URL", "http://localhost:7007")
BACKSTAGE_TOKEN = os.environ.get("BACKSTAGE_TOKEN", "")
PUSHGATEWAY_URL = os.environ.get("PUSHGATEWAY_URL", "http://prometheus-pushgateway.monitoring:9091")
MODE            = os.environ.get("MODE", "pushgateway")
CW_NAMESPACE    = os.environ.get("CLOUDWATCH_NS", "IDP/TechInsights")
AWS_REGION      = os.environ.get("AWS_REGION", "us-east-1")

HEADERS = {"Authorization": f"Bearer {BACKSTAGE_TOKEN}"} if BACKSTAGE_TOKEN else {}

# Scorecard checks — keep in sync with idpTechInsights.ts (the fact retriever).
# Order matters only for human-readable logs.
HYGIENE_CHECKS = [
    "has-owner",
    "has-techdocs",
    "has-health-probes",
    "has-runbook-url",
    "has-api-definition",
    "uses-pinned-image-tag",
]
QUALITY_GATE_CHECKS = [
    "has-coverage-gate",
    "has-static-analysis",
    "has-vuln-scan",
    "has-contract-tests",
    "has-e2e-tests",
]
SCORECARD_CHECKS = HYGIENE_CHECKS + QUALITY_GATE_CHECKS

# Tier thresholds (out of 11 checks):
#   Bronze ≥ 4  — baseline service hygiene (owner, techdocs, probes, …)
#   Silver ≥ 7  — adds shift-left CI gates (coverage, lint, vuln scan)
#   Gold   ≥ 10 — adds contract + e2e tests (full shift-left adoption)
TIER_THRESHOLDS = {"bronze": 4, "silver": 7, "gold": 10}


def fetch_entities():
    url = f"{BACKSTAGE_URL}/api/catalog/entities?filter=kind=Component"
    resp = requests.get(url, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    return resp.json()


def fetch_facts(entity_ref: str):
    url = f"{BACKSTAGE_URL}/api/tech-insights/facts/latest?entity={entity_ref}"
    resp = requests.get(url, headers=HEADERS, timeout=30)
    if resp.status_code == 404:
        return {}
    resp.raise_for_status()
    return resp.json()


def score_entity(facts: dict) -> dict:
    passed = sum(1 for c in SCORECARD_CHECKS if facts.get(c, {}).get("value") is True)
    # Per-check booleans so the dashboard can drill into which gate failed.
    check_results = {c: facts.get(c, {}).get("value") is True for c in SCORECARD_CHECKS}
    tier = "none"
    for t, threshold in sorted(TIER_THRESHOLDS.items(), key=lambda x: x[1]):
        if passed >= threshold:
            tier = t
    return {
        "passed": passed,
        "total": len(SCORECARD_CHECKS),
        "tier": tier,
        "checks": check_results,
    }


def push_to_pushgateway(metrics: list[dict]):
    lines = []
    lines.append("# HELP idp_scorecard_checks_passed Number of Tech Insights checks passing")
    lines.append("# TYPE idp_scorecard_checks_passed gauge")
    for m in metrics:
        labels = f'service="{m["service"]}",team="{m["team"]}",tier="{m["tier"]}"'
        lines.append(f'idp_scorecard_checks_passed{{{labels}}} {m["passed"]}')

    # Per-tier gauges so the dashboard can show Bronze/Silver/Gold side-by-side.
    for tier_name in ("bronze", "silver", "gold"):
        lines.append(f"# HELP idp_scorecard_tier_{tier_name} 1 if service has reached {tier_name.title()} tier")
        lines.append(f"# TYPE idp_scorecard_tier_{tier_name} gauge")
        for m in metrics:
            # Tiers nest: gold implies silver implies bronze.
            tier_rank = {"none": 0, "bronze": 1, "silver": 2, "gold": 3}
            target_rank = tier_rank[tier_name]
            val = 1 if tier_rank.get(m["tier"], 0) >= target_rank else 0
            labels = f'service="{m["service"]}",team="{m["team"]}"'
            lines.append(f'idp_scorecard_tier_{tier_name}{{{labels}}} {val}')

    # Per-check pass/fail so a dashboard can show "which gate is the weakest link?"
    lines.append("# HELP idp_scorecard_check_passed 1 if a specific scorecard check passes for this service")
    lines.append("# TYPE idp_scorecard_check_passed gauge")
    for m in metrics:
        for check, passed_bool in m["checks"].items():
            labels = (
                f'service="{m["service"]}",team="{m["team"]}",'
                f'check="{check}"'
            )
            lines.append(f'idp_scorecard_check_passed{{{labels}}} {1 if passed_bool else 0}')

    payload = "\n".join(lines) + "\n"
    url = f"{PUSHGATEWAY_URL}/metrics/job/tech-insights-exporter"
    resp = requests.post(url, data=payload, timeout=30)
    resp.raise_for_status()
    log.info("Pushed %d service metrics to Pushgateway", len(metrics))


def push_to_cloudwatch(metrics: list[dict]):
    import boto3
    cw = boto3.client("cloudwatch", region_name=AWS_REGION)
    tier_rank = {"none": 0, "bronze": 1, "silver": 2, "gold": 3}
    data = []
    for m in metrics:
        base_dims = [
            {"Name": "Service", "Value": m["service"]},
            {"Name": "Team",    "Value": m["team"]},
        ]
        data.append({
            "MetricName": "ScorecardChecksPassed",
            "Dimensions": base_dims + [{"Name": "Tier", "Value": m["tier"]}],
            "Value": m["passed"],
            "Unit": "Count",
        })
        for tier_name in ("bronze", "silver", "gold"):
            target = tier_rank[tier_name]
            data.append({
                "MetricName": f"ScorecardTier{tier_name.title()}",
                "Dimensions": base_dims,
                "Value": 1 if tier_rank.get(m["tier"], 0) >= target else 0,
                "Unit": "Count",
            })
        for check, passed_bool in m["checks"].items():
            data.append({
                "MetricName": "ScorecardCheckPassed",
                "Dimensions": base_dims + [{"Name": "Check", "Value": check}],
                "Value": 1 if passed_bool else 0,
                "Unit": "Count",
            })
    for i in range(0, len(data), 20):
        cw.put_metric_data(Namespace=CW_NAMESPACE, MetricData=data[i:i+20])
    log.info("Published %d service metrics to CloudWatch namespace %s", len(data), CW_NAMESPACE)


def main():
    log.info("Fetching entities from Backstage at %s", BACKSTAGE_URL)
    try:
        entities = fetch_entities()
    except Exception as e:
        log.error("Failed to fetch entities: %s", e)
        sys.exit(1)

    metrics = []
    for entity in entities:
        meta = entity.get("metadata", {})
        spec = entity.get("spec", {})
        name = meta.get("name", "unknown")
        team = spec.get("owner", "unknown")
        ref  = f"component:default/{name}"

        try:
            facts = fetch_facts(ref)
            score = score_entity(facts)
            metrics.append({"service": name, "team": team, **score})
            log.info("%s — %d/%d checks passed (tier: %s)", name, score["passed"], score["total"], score["tier"])
        except Exception as e:
            log.warning("Skipping %s: %s", name, e)

    if not metrics:
        log.warning("No metrics collected — exiting")
        sys.exit(0)

    if MODE == "cloudwatch":
        push_to_cloudwatch(metrics)
    else:
        push_to_pushgateway(metrics)


if __name__ == "__main__":
    main()
