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
OPENCOST_URL    = os.environ.get("OPENCOST_URL", "http://opencost.opencost.svc.cluster.local:9003")

# Monthly budget USD per team — mirrors idp.io/cost-budget-monthly-usd annotations
# in backstage/catalog/catalog-info.yaml and kubernetes/finops/team-budgets-configmap.yaml.
import json as _json
_BUDGET_JSON = os.environ.get("TEAM_BUDGETS_JSON", "")
TEAM_BUDGETS: dict[str, float] = _json.loads(_BUDGET_JSON) if _BUDGET_JSON else {
    "platform-team": 2000.0,
    "ml-team":       1500.0,
    "backend-team":   600.0,
    "data-team":      800.0,
    "frontend-team":  400.0,
    "android-team":   300.0,
    "ios-team":       300.0,
    "qa-team":        200.0,
}

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


def fetch_team_costs() -> dict[str, float]:
    """Query OpenCost /allocation API for month-to-date cost per team label.

    Returns {team_name: total_cost_usd}. Falls back to an empty dict so
    scorecard export still succeeds even when OpenCost is unavailable.
    """
    try:
        url = (
            f"{OPENCOST_URL}/allocation/compute"
            "?window=month&aggregate=label:team&accumulate=true"
        )
        resp = requests.get(url, timeout=15)
        resp.raise_for_status()
        data = resp.json().get("data", [])
        # OpenCost returns a list with one element per window chunk.
        costs: dict[str, float] = {}
        for chunk in data:
            for team, alloc in chunk.items():
                if team == "__idle__":
                    continue
                costs[team] = costs.get(team, 0.0) + float(alloc.get("totalCost", 0.0))
        return costs
    except Exception as e:
        log.warning("OpenCost unavailable — skipping team cost metrics: %s", e)
        return {}


def push_team_budget_metrics(actuals: dict[str, float]) -> None:
    """Push idp_team_budget_usd_monthly and idp_team_actual_cost_usd_monthly to Pushgateway."""
    lines = [
        "# HELP idp_team_budget_usd_monthly Configured monthly budget in USD for the team",
        "# TYPE idp_team_budget_usd_monthly gauge",
    ]
    for team, budget in TEAM_BUDGETS.items():
        lines.append(f'idp_team_budget_usd_monthly{{team="{team}"}} {budget}')

    lines += [
        "# HELP idp_team_actual_cost_usd_monthly Month-to-date actual Kubernetes spend in USD",
        "# TYPE idp_team_actual_cost_usd_monthly gauge",
    ]
    for team, budget in TEAM_BUDGETS.items():
        actual = actuals.get(team, 0.0)
        lines.append(f'idp_team_actual_cost_usd_monthly{{team="{team}"}} {actual:.4f}')

    lines += [
        "# HELP idp_team_budget_utilization_ratio Ratio of actual cost to monthly budget (0–1+)",
        "# TYPE idp_team_budget_utilization_ratio gauge",
    ]
    for team, budget in TEAM_BUDGETS.items():
        actual = actuals.get(team, 0.0)
        ratio = actual / budget if budget > 0 else 0.0
        lines.append(f'idp_team_budget_utilization_ratio{{team="{team}"}} {ratio:.4f}')

    payload = "\n".join(lines) + "\n"
    url = f"{PUSHGATEWAY_URL}/metrics/job/team-cost-budget-exporter"
    resp = requests.post(url, data=payload, timeout=30)
    resp.raise_for_status()
    log.info("Pushed team cost budget metrics to Pushgateway (%d teams)", len(TEAM_BUDGETS))


def fetch_entities():
    url = f"{BACKSTAGE_URL}/api/catalog/entities?filter=kind=Component"
    resp = requests.get(url, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    return resp.json()


def fetch_facts(entity_ref: str):
    url = f"{BACKSTAGE_URL}/api/tech-insights/facts/latest?entity={entity_ref}&ids[]=idp-entity-facts"
    resp = requests.get(url, headers=HEADERS, timeout=30)
    if resp.status_code == 404:
        return {}
    resp.raise_for_status()
    data = resp.json()
    return data.get("idp-entity-facts", {}).get("facts", {})


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

    # ── Team cost budgets (Pushgateway only; CloudWatch cost data comes from AWS Budgets) ──
    if MODE == "pushgateway":
        actuals = fetch_team_costs()
        push_team_budget_metrics(actuals)


if __name__ == "__main__":
    main()
