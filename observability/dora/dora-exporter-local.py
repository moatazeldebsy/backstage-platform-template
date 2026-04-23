#!/usr/bin/env python3
"""
DORA Metrics Exporter — local variant
Queries GitHub Actions API for workflow run history across all service repos,
computes the four DORA metrics, and pushes them to a Prometheus Pushgateway.

Runs as a Kubernetes CronJob every 15 minutes.

Environment variables:
  GITHUB_TOKEN      — GitHub PAT with repo + actions:read scope
  GITHUB_ORG        — GitHub organisation (e.g. YOUR_GITHUB_ORG)
  PUSHGATEWAY_URL   — Prometheus Pushgateway endpoint (default: http://prometheus-pushgateway.monitoring.svc.cluster.local:9091)
  LOOKBACK_HOURS    — how far back to query (default: 24)
"""
import os
import logging
from datetime import datetime, timezone, timedelta

import requests
from prometheus_client import CollectorRegistry, Gauge, push_to_gateway

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

GITHUB_TOKEN    = os.environ["GITHUB_TOKEN"]
GITHUB_ORG      = os.environ.get("GITHUB_ORG", "YOUR_GITHUB_ORG")
PUSHGATEWAY_URL = os.environ.get(
    "PUSHGATEWAY_URL",
    "http://prometheus-pushgateway.monitoring.svc.cluster.local:9091",
)
LOOKBACK_HOURS  = int(os.environ.get("LOOKBACK_HOURS", "24"))

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


def get_service_repos() -> list[str]:
    """Return all repos for the GitHub user/org that have build-and-deploy.yml."""
    org_url  = f"https://api.github.com/orgs/{GITHUB_ORG}/repos"
    user_url = "https://api.github.com/user/repos"
    probe = requests.get(org_url, headers=GH_HEADERS, params={"per_page": 1}, timeout=10)
    list_url = org_url if probe.status_code == 200 else user_url
    log.info("Using repo list endpoint: %s", list_url)
    repos = gh_get(list_url, {"per_page": 100, "type": "all"})
    service_repos = []
    for repo in repos:
        name = repo["name"]
        check = requests.get(
            f"https://api.github.com/repos/{GITHUB_ORG}/{name}/contents/.github/workflows/build-and-deploy.yml",
            headers=GH_HEADERS, timeout=10
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
    total    = len(prod_runs)
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


def push_metrics(service: str, deploy_freq: float, lead_time: float, cfr: float, mttr: float):
    """Push per-service DORA metrics to Prometheus Pushgateway."""
    registry = CollectorRegistry()
    grouping = {"service": service}

    Gauge("dora_deploy_frequency_per_day",
          "Deployments per day (successful prod deploys)",
          ["service"], registry=registry).labels(service=service).set(deploy_freq)

    Gauge("dora_lead_time_minutes",
          "Average lead time from commit to prod deploy (minutes)",
          ["service"], registry=registry).labels(service=service).set(lead_time)

    Gauge("dora_change_failure_rate_percent",
          "Percentage of prod deploys that resulted in failure",
          ["service"], registry=registry).labels(service=service).set(cfr)

    Gauge("dora_mttr_minutes",
          "Mean time to restore after a failed prod deploy (minutes)",
          ["service"], registry=registry).labels(service=service).set(mttr)

    push_to_gateway(PUSHGATEWAY_URL, job="dora-exporter",
                    grouping_key=grouping, registry=registry)


def push_aggregate_metrics(repos: list, all_deploy_freq: list, all_lead_times: list,
                           all_cfr: list, all_mttr: list):
    """Push org-wide aggregate DORA metrics to Prometheus Pushgateway."""
    registry = CollectorRegistry()
    grouping = {"service": "all-services"}

    Gauge("dora_deploy_frequency_per_day",
          "Deployments per day (successful prod deploys)",
          ["service"], registry=registry).labels(service="all-services").set(sum(all_deploy_freq))

    Gauge("dora_lead_time_minutes",
          "Average lead time from commit to prod deploy (minutes)",
          ["service"], registry=registry).labels(service="all-services").set(
              sum(all_lead_times) / len(all_lead_times))

    Gauge("dora_change_failure_rate_percent",
          "Percentage of prod deploys that resulted in failure",
          ["service"], registry=registry).labels(service="all-services").set(
              sum(all_cfr) / len(all_cfr))

    Gauge("dora_mttr_minutes",
          "Mean time to restore after a failed prod deploy (minutes)",
          ["service"], registry=registry).labels(service="all-services").set(
              sum(all_mttr) / len(all_mttr) if all_mttr else 0)

    push_to_gateway(PUSHGATEWAY_URL, job="dora-exporter",
                    grouping_key=grouping, registry=registry)


def main():
    since = datetime.now(timezone.utc) - timedelta(hours=LOOKBACK_HOURS)
    log.info("Collecting DORA metrics since %s for org %s", since.isoformat(), GITHUB_ORG)
    log.info("Pushing to Pushgateway at %s", PUSHGATEWAY_URL)

    repos = get_service_repos()
    all_deploy_freq: list[float] = []
    all_lead_times:  list[float] = []
    all_cfr:         list[float] = []
    all_mttr:        list[float] = []

    for repo in repos:
        log.info("Processing repo: %s", repo)
        try:
            runs      = get_workflow_runs(repo, since)
            prod_runs = [r for r in runs if r.get("head_branch") == "main"]

            deploy_freq = compute_deploy_frequency(prod_runs, LOOKBACK_HOURS)
            lead_time   = compute_lead_time(prod_runs)
            cfr         = compute_change_failure_rate(prod_runs)
            mttr        = compute_mttr(prod_runs)

            push_metrics(repo, deploy_freq, lead_time, cfr, mttr)

            log.info("%s — deploys/day=%.2f lead_time=%.1fm CFR=%.1f%% MTTR=%.1fm",
                     repo, deploy_freq, lead_time, cfr, mttr)

            all_deploy_freq.append(deploy_freq)
            all_lead_times.append(lead_time)
            all_cfr.append(cfr)
            all_mttr.append(mttr)

        except Exception as exc:
            log.warning("Failed to process %s: %s", repo, exc)

    if all_deploy_freq:
        push_aggregate_metrics(repos, all_deploy_freq, all_lead_times, all_cfr, all_mttr)
        log.info("Published aggregate metrics for %d services.", len(repos))


if __name__ == "__main__":
    main()
