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

SCORECARD_CHECKS = [
    "has-owner",
    "has-techdocs",
    "has-health-probes",
    "has-runbook-url",
    "has-api-definition",
    "uses-pinned-image-tag",
]

TIER_THRESHOLDS = {"bronze": 2, "silver": 4, "gold": 6}


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
    tier = "none"
    for t, threshold in sorted(TIER_THRESHOLDS.items(), key=lambda x: x[1]):
        if passed >= threshold:
            tier = t
    return {"passed": passed, "total": len(SCORECARD_CHECKS), "tier": tier}


def push_to_pushgateway(metrics: list[dict]):
    lines = []
    lines.append("# HELP idp_scorecard_checks_passed Number of Tech Insights checks passing")
    lines.append("# TYPE idp_scorecard_checks_passed gauge")
    for m in metrics:
        labels = f'service="{m["service"]}",team="{m["team"]}",tier="{m["tier"]}"'
        lines.append(f'idp_scorecard_checks_passed{{{labels}}} {m["passed"]}')
    lines.append("# HELP idp_scorecard_tier_gold 1 if service has Gold scorecard tier")
    lines.append("# TYPE idp_scorecard_tier_gold gauge")
    for m in metrics:
        val = 1 if m["tier"] == "gold" else 0
        labels = f'service="{m["service"]}",team="{m["team"]}"'
        lines.append(f'idp_scorecard_tier_gold{{{labels}}} {val}')

    payload = "\n".join(lines) + "\n"
    url = f"{PUSHGATEWAY_URL}/metrics/job/tech-insights-exporter"
    resp = requests.post(url, data=payload, timeout=30)
    resp.raise_for_status()
    log.info("Pushed %d service metrics to Pushgateway", len(metrics))


def push_to_cloudwatch(metrics: list[dict]):
    import boto3
    cw = boto3.client("cloudwatch", region_name=AWS_REGION)
    data = []
    for m in metrics:
        data.append({
            "MetricName": "ScorecardChecksPassed",
            "Dimensions": [
                {"Name": "Service", "Value": m["service"]},
                {"Name": "Team",    "Value": m["team"]},
                {"Name": "Tier",    "Value": m["tier"]},
            ],
            "Value": m["passed"],
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
