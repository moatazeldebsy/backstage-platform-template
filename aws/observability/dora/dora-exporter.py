#!/usr/bin/env python3
"""
DORA Metrics Exporter
Queries GitHub Actions API for workflow run history across all service repos,
computes the four DORA metrics, and publishes them to:
  - Prometheus Pushgateway (scraped by Prometheus → Grafana dashboard)
  - CloudWatch (for AWS-native alerting, optional)

Runs as a Kubernetes CronJob every 15 minutes.

Environment variables:
  GITHUB_TOKEN        — GitHub PAT with repo + actions:read scope
  GITHUB_ORG          — GitHub organisation (e.g. moatazeldebsy)
  PUSHGATEWAY_URL     — Pushgateway base URL (e.g. http://prometheus-pushgateway.monitoring:9091)
  AWS_REGION          — AWS region for CloudWatch (default: us-east-1)
  LOOKBACK_HOURS      — how far back to query (default: 24)
  CLOUDWATCH_NS       — CloudWatch namespace (default: IDP/DORA)
  SKIP_CLOUDWATCH     — set to "true" to skip CloudWatch publishing
"""
import os
import json
import time
import logging
import urllib.request
import urllib.error
from datetime import datetime, timezone, timedelta

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

GITHUB_TOKEN       = os.environ["GITHUB_TOKEN"]
GITHUB_ORG         = os.environ.get("GITHUB_ORG", "moatazeldebsy")
PUSHGATEWAY_URL    = os.environ.get("PUSHGATEWAY_URL", "http://prometheus-pushgateway.monitoring.svc.cluster.local:9091")
AWS_REGION         = os.environ.get("AWS_REGION", "us-east-1")
LOOKBACK_HOURS     = int(os.environ.get("LOOKBACK_HOURS", "24"))
CW_NAMESPACE       = os.environ.get("CLOUDWATCH_NS", "IDP/DORA")
SKIP_CLOUDWATCH    = os.environ.get("SKIP_CLOUDWATCH", "false").lower() == "true"
REPO_FILTER_TOPIC  = os.environ.get("REPO_FILTER_TOPIC", "idp-app")
REPO_INCLUDE       = os.environ.get("REPO_INCLUDE", "")
# JSON map of repo name → team name, e.g. '{"orders-service":"payments","auth-api":"platform"}'
# Repos not in the map fall back to the team-name embedded in the GitHub topic "team:<name>".
TEAM_MAP: dict = json.loads(os.environ.get("TEAM_MAP", "{}"))

GH_HEADERS = {
    "Authorization": f"Bearer {GITHUB_TOKEN}",
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
}


def gh_get(url: str, params: dict = None) -> list:
    """Paginate through all pages of a GitHub API endpoint."""
    results = []
    while url:
        resp = requests.get(url, headers=GH_HEADERS, params=params, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        if isinstance(data, list):
            results.extend(data)
        elif "workflow_runs" in data:
            results.extend(data["workflow_runs"])
        elif "items" in data:
            results.extend(data["items"])
        else:
            results.append(data)
        url = resp.links.get("next", {}).get("url")
        params = None
    return results


def get_team_for_repo(repo: str, topics: list[str] | None = None) -> str:
    """Return the team name for a repo: explicit map → topic → 'unknown'."""
    if repo in TEAM_MAP:
        return TEAM_MAP[repo]
    for topic in (topics or []):
        if topic.startswith("team:"):
            return topic[len("team:"):]
    return "unknown"


def get_service_repos() -> list:
    """Return IDP-managed service repos.

    Priority:
    1. REPO_INCLUDE — explicit comma-separated allowlist.
    2. REPO_FILTER_TOPIC (default: "idp-app") — GitHub topic set by all scaffold templates.
    3. Fallback — repos containing build-and-deploy.yml.
    """
    if REPO_INCLUDE:
        repos = [r.strip() for r in REPO_INCLUDE.split(",") if r.strip()]
        log.info("Using explicit REPO_INCLUDE allowlist (%d repos): %s", len(repos), repos)
        return repos

    if REPO_FILTER_TOPIC:
        log.info("Filtering repos by GitHub topic '%s'", REPO_FILTER_TOPIC)
        results = gh_get(
            "https://api.github.com/search/repositories",
            {"q": f"user:{GITHUB_ORG} topic:{REPO_FILTER_TOPIC}", "per_page": 100},
        )
        repos = [r["name"] for r in results]
        log.info("Found %d repos with topic '%s': %s", len(repos), REPO_FILTER_TOPIC, repos)
        return repos

    org_url  = f"https://api.github.com/orgs/{GITHUB_ORG}/repos"
    user_url = "https://api.github.com/user/repos"
    probe = requests.get(org_url, headers=GH_HEADERS, params={"per_page": 1}, timeout=10)
    list_url = org_url if probe.status_code == 200 else user_url
    log.info("Falling back to workflow-file check via %s", list_url)
    all_repos = gh_get(list_url, {"per_page": 100, "type": "all"})
    service_repos = []
    for repo in all_repos:
        name = repo["name"]
        check = requests.get(
            f"https://api.github.com/repos/{GITHUB_ORG}/{name}/contents/.github/workflows/build-and-deploy.yml",
            headers=GH_HEADERS, timeout=10,
        )
        if check.status_code == 200:
            service_repos.append(name)
    log.info("Found %d service repos: %s", len(service_repos), service_repos)
    return service_repos


def get_workflow_runs(repo: str, since: datetime) -> list:
    since_str = since.strftime("%Y-%m-%dT%H:%M:%SZ")
    return gh_get(
        f"https://api.github.com/repos/{GITHUB_ORG}/{repo}/actions/runs",
        {"per_page": 100, "created": f">={since_str}"}
    )


def compute_deploy_frequency(prod_runs: list, window_hours: int) -> float:
    successes = [r for r in prod_runs if r.get("conclusion") == "success"]
    return len(successes) / (window_hours / 24.0) if window_hours > 0 else 0.0


def compute_lead_time(prod_runs: list) -> float:
    lead_times = []
    for run in prod_runs:
        if run.get("conclusion") != "success":
            continue
        created = datetime.fromisoformat(run["created_at"].replace("Z", "+00:00"))
        updated = datetime.fromisoformat(run["updated_at"].replace("Z", "+00:00"))
        lead_times.append((updated - created).total_seconds() / 60.0)
    return sum(lead_times) / len(lead_times) if lead_times else 0.0


def compute_change_failure_rate(prod_runs: list) -> float:
    total = len(prod_runs)
    failures = len([r for r in prod_runs if r.get("conclusion") in ("failure", "cancelled")])
    return (failures / total * 100.0) if total > 0 else 0.0


def compute_mttr(prod_runs: list) -> float:
    mttr_values = []
    sorted_runs = sorted(prod_runs, key=lambda r: r["created_at"])
    for i, run in enumerate(sorted_runs):
        if run.get("conclusion") not in ("failure", "cancelled"):
            continue
        fail_time = datetime.fromisoformat(run["created_at"].replace("Z", "+00:00"))
        for later in sorted_runs[i + 1:]:
            if later.get("conclusion") == "success" and later.get("head_branch") == run.get("head_branch"):
                restore_time = datetime.fromisoformat(later["updated_at"].replace("Z", "+00:00"))
                mttr_values.append((restore_time - fail_time).total_seconds() / 60.0)
                break
    return sum(mttr_values) / len(mttr_values) if mttr_values else 0.0


def push_to_gateway(job: str, service: str, metrics: dict, team: str = "unknown"):
    """Push metrics to Prometheus Pushgateway in text exposition format."""
    lines = []
    for name, (value, help_text, metric_type) in metrics.items():
        lines.append(f"# HELP {name} {help_text}")
        lines.append(f"# TYPE {name} {metric_type}")
        lines.append(f'{name}{{service="{service}",team="{team}"}} {value}')
    payload = "\n".join(lines) + "\n"

    url = f"{PUSHGATEWAY_URL}/metrics/job/{job}/service/{service}"
    try:
        req = urllib.request.Request(
            url,
            data=payload.encode("utf-8"),
            method="POST",
            headers={"Content-Type": "text/plain; version=0.0.4"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            log.info("Pushgateway push OK for service=%s (HTTP %s)", service, resp.status)
    except Exception as exc:
        log.warning("Pushgateway push failed for service=%s: %s", service, exc)


def get_repo_topics(repo: str) -> list[str]:
    try:
        data = gh_get(f"https://api.github.com/repos/{GITHUB_ORG}/{repo}/topics")
        return data[0].get("names", []) if data else []
    except Exception:
        return []


def put_cloudwatch(metric_name: str, value: float, unit: str, dimensions: list):
    try:
        import boto3
        cw = boto3.client("cloudwatch", region_name=AWS_REGION)
        cw.put_metric_data(
            Namespace=CW_NAMESPACE,
            MetricData=[{
                "MetricName": metric_name,
                "Value": value,
                "Unit": unit,
                "Timestamp": datetime.now(timezone.utc),
                "Dimensions": dimensions,
            }]
        )
    except Exception as exc:
        log.warning("CloudWatch publish failed: %s", exc)


def main():
    since = datetime.now(timezone.utc) - timedelta(hours=LOOKBACK_HOURS)
    log.info("Collecting DORA metrics since %s for org %s", since.isoformat(), GITHUB_ORG)

    repos = get_service_repos()
    all_deploy_freq, all_lead_times, all_cfr, all_mttr = [], [], [], []

    for repo in repos:
        log.info("Processing repo: %s", repo)
        try:
            topics    = get_repo_topics(repo)
            team      = get_team_for_repo(repo, topics)
            runs      = get_workflow_runs(repo, since)
            prod_runs = [r for r in runs if r.get("head_branch") == "main"]

            deploy_freq = compute_deploy_frequency(prod_runs, LOOKBACK_HOURS)
            lead_time   = compute_lead_time(prod_runs)
            cfr         = compute_change_failure_rate(prod_runs)
            mttr        = compute_mttr(prod_runs)

            log.info("%s (team=%s) — deploys/day=%.2f lead_time=%.1fm CFR=%.1f%% MTTR=%.1fm",
                     repo, team, deploy_freq, lead_time, cfr, mttr)

            # Push to Prometheus Pushgateway (names match Grafana dashboard queries)
            push_to_gateway("dora-exporter", repo, {
                "dora_deploy_frequency_per_day": (deploy_freq, "DORA deployment frequency (deploys per day)", "gauge"),
                "dora_lead_time_minutes":        (lead_time,   "DORA lead time for changes (minutes)",        "gauge"),
                "dora_change_failure_rate":      (cfr,         "DORA change failure rate (percent)",          "gauge"),
                "dora_mttr_minutes":             (mttr,        "DORA mean time to restore (minutes)",         "gauge"),
            }, team=team)

            # Also push to CloudWatch (for AWS-native alerting)
            if not SKIP_CLOUDWATCH:
                dims = [{"Name": "Service", "Value": repo}, {"Name": "Team", "Value": team}]
                put_cloudwatch("DeployFrequency",   deploy_freq, "None",    dims)
                put_cloudwatch("LeadTime",           lead_time,   "Count",   dims)
                put_cloudwatch("ChangeFailureRate",  cfr,         "Percent", dims)
                put_cloudwatch("MTTR",               mttr,        "Count",   dims)

            all_deploy_freq.append(deploy_freq)
            all_lead_times.append(lead_time)
            all_cfr.append(cfr)
            all_mttr.append(mttr)

        except Exception as exc:
            log.warning("Failed to process %s: %s", repo, exc)

    # Aggregate across all services
    if all_deploy_freq:
        agg_deploy_freq = sum(all_deploy_freq)
        agg_lead_time   = sum(all_lead_times) / len(all_lead_times)
        agg_cfr         = sum(all_cfr) / len(all_cfr)
        agg_mttr        = sum(all_mttr) / len(all_mttr) if all_mttr else 0.0

        push_to_gateway("dora-exporter", "all-services", {
            "dora_deploy_frequency_per_day": (agg_deploy_freq, "DORA deployment frequency (deploys per day)", "gauge"),
            "dora_lead_time_minutes":        (agg_lead_time,   "DORA lead time for changes (minutes)",        "gauge"),
            "dora_change_failure_rate":      (agg_cfr,         "DORA change failure rate (percent)",          "gauge"),
            "dora_mttr_minutes":             (agg_mttr,        "DORA mean time to restore (minutes)",         "gauge"),
        })

        if not SKIP_CLOUDWATCH:
            agg_dims = [{"Name": "Aggregate", "Value": "all-services"}, {"Name": "Team", "Value": "all"}]
            put_cloudwatch("DeployFrequency",   agg_deploy_freq, "None",    agg_dims)
            put_cloudwatch("LeadTime",          agg_lead_time,   "Count",   agg_dims)
            put_cloudwatch("ChangeFailureRate", agg_cfr,         "Percent", agg_dims)
            put_cloudwatch("MTTR",              agg_mttr,        "Count",   agg_dims)

        log.info("Published aggregate metrics for %d services.", len(repos))


if __name__ == "__main__":
    main()
