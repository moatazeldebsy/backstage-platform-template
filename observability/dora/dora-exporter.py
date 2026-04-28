#!/usr/bin/env python3
"""
DORA Metrics Exporter
Queries GitHub Actions API for workflow run history across all service repos,
computes the four DORA metrics, and publishes them to CloudWatch.

Runs as a Kubernetes CronJob every 15 minutes.

Environment variables:
  GITHUB_TOKEN      — GitHub PAT with repo + actions:read scope
  GITHUB_ORG        — GitHub organisation (e.g. YOUR_GITHUB_ORG)
  AWS_REGION        — AWS region for CloudWatch (e.g. us-east-1)
  LOOKBACK_HOURS    — how far back to query (default: 24)
  CLOUDWATCH_NS     — CloudWatch namespace (default: IDP/DORA)
"""
import os
import json
import time
import logging
from datetime import datetime, timezone, timedelta

import boto3
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

GITHUB_TOKEN   = os.environ["GITHUB_TOKEN"]
GITHUB_ORG     = os.environ.get("GITHUB_ORG", "YOUR_GITHUB_ORG")
AWS_REGION     = os.environ.get("AWS_REGION", "us-east-1")
LOOKBACK_HOURS = int(os.environ.get("LOOKBACK_HOURS", "24"))
CW_NAMESPACE   = os.environ.get("CLOUDWATCH_NS", "IDP/DORA")

GH_HEADERS = {
    "Authorization": f"Bearer {GITHUB_TOKEN}",
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
}

cw = boto3.client("cloudwatch", region_name=AWS_REGION)


def gh_get(url: str, params: dict = None) -> list:
    """Paginate through all pages of a GitHub API endpoint."""
    results = []
    while url:
        resp = requests.get(url, headers=GH_HEADERS, params=params, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        # Different endpoints wrap results differently
        if isinstance(data, list):
            results.extend(data)
        elif "workflow_runs" in data:
            results.extend(data["workflow_runs"])
        elif "items" in data:
            results.extend(data["items"])
        else:
            results.append(data)
        url = resp.links.get("next", {}).get("url")
        params = None  # params only on first request; subsequent pages are full URLs
    return results


def get_service_repos() -> list[str]:
    """Return all repos for the GitHub user/org that have build-and-deploy.yml."""
    # Try org endpoint first; fall back to authenticated user endpoint.
    # /users/{user}/repos only returns public repos — use /user/repos for private access.
    org_url = f"https://api.github.com/orgs/{GITHUB_ORG}/repos"
    user_url = "https://api.github.com/user/repos"   # authenticated user — includes private
    probe = requests.get(org_url, headers=GH_HEADERS, params={"per_page": 1}, timeout=10)
    list_url = org_url if probe.status_code == 200 else user_url
    log.info("Using repo list endpoint: %s", list_url)
    repos = gh_get(list_url, {"per_page": 100, "type": "all"})
    service_repos = []
    for repo in repos:
        name = repo["name"]
        # Quick heuristic: check for our workflow file
        check = requests.get(
            f"https://api.github.com/repos/{GITHUB_ORG}/{name}/contents/.github/workflows/build-and-deploy.yml",
            headers=GH_HEADERS, timeout=10
        )
        if check.status_code == 200:
            service_repos.append(name)
    log.info("Found %d service repos: %s", len(service_repos), service_repos)
    return service_repos


def get_workflow_runs(repo: str, since: datetime) -> list:
    """Get all workflow runs for a repo since a given datetime."""
    since_str = since.strftime("%Y-%m-%dT%H:%M:%SZ")
    runs = gh_get(
        f"https://api.github.com/repos/{GITHUB_ORG}/{repo}/actions/runs",
        {"per_page": 100, "created": f">={since_str}"}
    )
    return runs


def compute_deploy_frequency(prod_runs: list, window_hours: int) -> float:
    """Deployments per day = count of successful prod deploys / window in days."""
    successes = [r for r in prod_runs if r.get("conclusion") == "success"]
    return len(successes) / (window_hours / 24.0) if window_hours > 0 else 0.0


def compute_lead_time(prod_runs: list) -> float:
    """Lead time in minutes: avg time from workflow trigger (first commit push) to prod deploy completion."""
    lead_times = []
    for run in prod_runs:
        if run.get("conclusion") != "success":
            continue
        created = datetime.fromisoformat(run["created_at"].replace("Z", "+00:00"))
        updated = datetime.fromisoformat(run["updated_at"].replace("Z", "+00:00"))
        lead_times.append((updated - created).total_seconds() / 60.0)
    return sum(lead_times) / len(lead_times) if lead_times else 0.0


def compute_change_failure_rate(all_runs: list, prod_runs: list) -> float:
    """CFR = failed prod deploys / total prod deploys (%)."""
    total = len(prod_runs)
    failures = len([r for r in prod_runs if r.get("conclusion") in ("failure", "cancelled")])
    return (failures / total * 100.0) if total > 0 else 0.0


def compute_mttr(failed_runs: list) -> float:
    """
    MTTR in minutes: for each failure, time until the next successful run on the same repo/branch.
    Approximation — a real MTTR needs incident tracking.
    """
    mttr_values = []
    sorted_runs = sorted(failed_runs, key=lambda r: r["created_at"])
    for i, run in enumerate(sorted_runs):
        if run.get("conclusion") not in ("failure", "cancelled"):
            continue
        fail_time = datetime.fromisoformat(run["created_at"].replace("Z", "+00:00"))
        # Find next success on same branch
        for later in sorted_runs[i + 1:]:
            if later.get("conclusion") == "success" and later.get("head_branch") == run.get("head_branch"):
                restore_time = datetime.fromisoformat(later["updated_at"].replace("Z", "+00:00"))
                mttr_values.append((restore_time - fail_time).total_seconds() / 60.0)
                break
    return sum(mttr_values) / len(mttr_values) if mttr_values else 0.0


def put_metric(metric_name: str, value: float, unit: str, dimensions: list):
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


def main():
    since = datetime.now(timezone.utc) - timedelta(hours=LOOKBACK_HOURS)
    log.info("Collecting DORA metrics since %s for org %s", since.isoformat(), GITHUB_ORG)

    repos = get_service_repos()
    all_deploy_freq = []
    all_lead_times  = []
    all_cfr         = []
    all_mttr        = []

    for repo in repos:
        log.info("Processing repo: %s", repo)
        try:
            runs = get_workflow_runs(repo, since)
            prod_runs = [r for r in runs if r.get("head_branch") == "main"]

            deploy_freq = compute_deploy_frequency(prod_runs, LOOKBACK_HOURS)
            lead_time   = compute_lead_time(prod_runs)
            cfr         = compute_change_failure_rate(runs, prod_runs)
            mttr        = compute_mttr(prod_runs)

            dims = [{"Name": "Service", "Value": repo}]
            put_metric("DeployFrequency",    deploy_freq, "None",      dims)
            put_metric("LeadTime",           lead_time,   "Count",     dims)  # minutes
            put_metric("ChangeFailureRate",  cfr,         "Percent",   dims)
            put_metric("MTTR",               mttr,        "Count",     dims)  # minutes

            log.info("%s — deploys/day=%.2f lead_time=%.1fm CFR=%.1f%% MTTR=%.1fm",
                     repo, deploy_freq, lead_time, cfr, mttr)

            all_deploy_freq.append(deploy_freq)
            all_lead_times.append(lead_time)
            all_cfr.append(cfr)
            all_mttr.append(mttr)

        except Exception as exc:
            log.warning("Failed to process %s: %s", repo, exc)

    # Aggregate metrics across all services
    if all_deploy_freq:
        agg_dims = [{"Name": "Aggregate", "Value": "all-services"}]
        put_metric("DeployFrequency",   sum(all_deploy_freq),                              "None",      agg_dims)
        put_metric("LeadTime",          sum(all_lead_times) / len(all_lead_times),         "Count",     agg_dims)
        put_metric("ChangeFailureRate", sum(all_cfr) / len(all_cfr),                       "Percent",   agg_dims)
        put_metric("MTTR",              sum(all_mttr) / len(all_mttr) if all_mttr else 0,  "Count",     agg_dims)
        log.info("Published aggregate metrics for %d services.", len(repos))


if __name__ == "__main__":
    main()
