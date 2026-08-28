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
from urllib.parse import quote

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
# Comma-separated list of GitHub topics. Defaults to the same pair the Backstage
# catalog discovers on (`catalog.providers.github.*.filters.topic.include` in
# app-config.yaml / app-config.aws.yaml): scaffolder templates tag new repos
# `idp-app`, while hand-registered and platform repos carry `idp`.
#
# This used to default to "idp-app" alone, which silently excluded every repo
# tagged only `idp` — including the platform repo itself, the one repo whose
# build-and-deploy workflow actually runs. The result was a DORA dashboard
# reporting 0.00 across the board while the exporter logged success, and it
# contradicted the empty-state text the UI already shows, which tells the user
# to check for the "idp" or "idp-app" topic.
REPO_FILTER_TOPICS = [
    t.strip() for t in os.environ.get("REPO_FILTER_TOPIC", "idp,idp-app").split(",") if t.strip()
]
REPO_INCLUDE       = os.environ.get("REPO_INCLUDE", "")
# Repos that hold more than one deployable service. For these, one repo-level
# DORA number is meaningless: the platform repo deploys hello-service and ten
# MCP servers from a single matrix workflow, so every one of those services had
# NO DORA series at all and its Backstage tab rendered empty, while the repo
# itself showed an average that belonged to no service in particular.
#
# GitHub names a matrix job "<job> (<service>)", so the per-service attribution
# is already in the run history — it just was never read. Costs one extra API
# call per workflow run, which is why it is opt-in per repo rather than global.
MONOREPO_REPOS = [
    r.strip() for r in os.environ.get("MONOREPO_REPOS", "backstage-platform-template").split(",") if r.strip()
]
# Only these workflows count as deployments for the per-service split. Without
# it, every matrix job in the repo is treated as a deploy: CI's
# `mcp-servers-build (qa-mcp-server)` inflates deployment frequency with test
# runs, and CodeQL's `Analyze (go)` invents services named "go" and
# "javascript-typescript". Deployment frequency has to mean deployments.
DEPLOY_WORKFLOW_NAMES = [
    w.strip() for w in os.environ.get("DEPLOY_WORKFLOW_NAMES", "Build and Deploy").split(",") if w.strip()
]
# JSON map of repo name → team name, e.g. '{"orders-service":"payments","auth-api":"platform"}'
# Repos not in the map fall back to the team-name embedded in the GitHub topic "team:<name>".
TEAM_MAP: dict = json.loads(os.environ.get("TEAM_MAP", "{}"))

GH_HEADERS = {
    "Authorization": f"Bearer {GITHUB_TOKEN}",
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
}


def gh_get(url: str, params: dict = None, max_pages: int | None = None) -> list:
    """Paginate through a GitHub API endpoint, optionally stopping after N pages.

    `max_pages` exists for the pull-request query, which has no `since` filter:
    a busy repo can hold thousands of closed PRs, and walking all of them every
    5 minutes would burn the rate limit for a mean that a recent sample already
    answers.
    """
    results = []
    pages = 0
    while url:
        resp = requests.get(url, headers=GH_HEADERS, params=params, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        if isinstance(data, list):
            results.extend(data)
        elif "workflow_runs" in data:
            results.extend(data["workflow_runs"])
        elif "jobs" in data:
            # /actions/runs/{id}/jobs wraps its list as {"total_count":N,"jobs":[...]}.
            # Without this branch it fell through to the append-the-whole-dict case
            # below, so callers iterated over a single envelope object and every
            # field lookup came back empty — silently, with no error to notice.
            results.extend(data["jobs"])
        elif "items" in data:
            results.extend(data["items"])
        else:
            results.append(data)
        pages += 1
        if max_pages is not None and pages >= max_pages:
            break
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
    2. REPO_FILTER_TOPIC (default: "idp,idp-app") — comma-separated GitHub topics,
       matching what the Backstage catalog discovers on. Scaffolder templates tag
       new repos "idp-app"; platform and hand-registered repos carry "idp".
    3. Fallback — repos containing build-and-deploy.yml.
    """
    if REPO_INCLUDE:
        repos = [r.strip() for r in REPO_INCLUDE.split(",") if r.strip()]
        log.info("Using explicit REPO_INCLUDE allowlist (%d repos): %s", len(repos), repos)
        return repos

    if REPO_FILTER_TOPICS:
        log.info("Filtering repos by GitHub topics %s", REPO_FILTER_TOPICS)
        # GitHub's search API ANDs repeated topic: qualifiers, so a single query
        # for "topic:idp topic:idp-app" would return only repos carrying BOTH.
        # Query each topic separately and union the results, de-duplicating by
        # name (a repo tagged with both must not be measured twice).
        repos: list[str] = []
        for topic in REPO_FILTER_TOPICS:
            results = gh_get(
                "https://api.github.com/search/repositories",
                {"q": f"user:{GITHUB_ORG} topic:{topic}", "per_page": 100},
            )
            found = [r["name"] for r in results]
            log.info("  topic '%s': %d repo(s)", topic, len(found))
            for name in found:
                if name not in repos:
                    repos.append(name)
        log.info("Found %d distinct repo(s) across topics %s: %s", len(repos), REPO_FILTER_TOPICS, repos)
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


def get_runs_by_service(repo: str, runs: list) -> dict:
    """Group a monorepo's deploy runs by the service each matrix job targeted.

    GitHub renders a matrix job as "<job-name> (<matrix-value>)", e.g.
    "promote-to-production (github-mcp-server)", so the per-service attribution
    already exists in the run history — it just was never read.

    Returns synthetic run records per service rather than the raw runs, because
    a monorepo run has ONE conclusion covering every service in it. Attributing
    that shared conclusion to each service blames a service for an unrelated
    matrix leg failing: services with no deploys at all came out at CFR=100%,
    since every run they appeared in had failed for someone else's reason. Each
    service is judged on its own jobs, and its finish time is its own last job's,
    so lead time measures that service's pipeline rather than the slowest one in
    the run.
    """
    by_service: dict = {}
    for run in runs:
        run_id = run.get("id")
        if not run_id:
            continue
        if DEPLOY_WORKFLOW_NAMES and run.get("name") not in DEPLOY_WORKFLOW_NAMES:
            continue
        try:
            jobs = gh_get(
                f"https://api.github.com/repos/{GITHUB_ORG}/{repo}/actions/runs/{run_id}/jobs",
                {"per_page": 100},
            )
        except Exception as exc:                      # noqa: BLE001 - best effort
            log.warning("Could not read jobs for run %s: %s", run_id, exc)
            continue

        per_service_jobs: dict = {}
        for job in jobs:
            name = job.get("name", "").rstrip()
            if "(" not in name or not name.endswith(")"):
                continue
            svc = name[name.rindex("(") + 1:-1].strip()
            # A skipped job is not evidence the service was deployed.
            if not svc or job.get("conclusion") in (None, "skipped"):
                continue
            per_service_jobs.setdefault(svc, []).append(job)

        for svc, svc_jobs in per_service_jobs.items():
            conclusions = [j.get("conclusion") for j in svc_jobs]
            if any(c in ("failure", "cancelled") for c in conclusions):
                conclusion = "failure"
            elif any(c == "success" for c in conclusions):
                conclusion = "success"
            else:
                continue
            completions = [j.get("completed_at") for j in svc_jobs if j.get("completed_at")]
            by_service.setdefault(svc, []).append({
                "id":          run_id,
                "conclusion":  conclusion,
                "created_at":  run.get("created_at"),
                "updated_at":  max(completions) if completions else run.get("updated_at"),
                "head_branch": run.get("head_branch"),
            })
    return by_service


# Developer Experience series. Names are the contract with the Engineering
# Intelligence Prometheus collector (packages/backend/src/modules/
# engineeringIntelligence/prometheus.ts) — change one and change the other.
#
# This block is duplicated verbatim in local/observability/dora/dora-exporter.py.
# The two exporters are a known drift pair (different discovery, team mapping and
# CloudWatch handling); these four functions must stay identical between them.
DEVEX_GAUGES = {
    "devex_pr_cycle_time_hours":  "Mean hours from pull request opened to merged",
    "devex_ci_duration_minutes":  "Mean wall-clock minutes per CI run, queue time included",
    "devex_build_failure_ratio":  "Failed CI runs as a fraction of runs that reached a verdict",
}


def get_recent_pull_requests(repo: str) -> list:
    """The most recently updated closed PRs.

    One bounded page. The GitHub pulls API has no `since` parameter, so this
    sorts by most-recently-updated and takes the first 100; callers filter to
    the window themselves. A repo merging more than 100 PRs inside the window
    is sampled rather than counted exhaustively, which is fine for a mean and
    is the trade the rate limit demands.
    """
    return gh_get(
        f"https://api.github.com/repos/{GITHUB_ORG}/{repo}/pulls",
        {"state": "closed", "sort": "updated", "direction": "desc", "per_page": 100},
        max_pages=1,
    )


def compute_pr_cycle_time(prs: list, since: datetime) -> float:
    """Mean hours from a pull request being opened to being merged.

    Closed-without-merge PRs are excluded: abandoning a change is not a slow
    review, and counting it as one would make a team look worse for cleaning up.
    """
    durations = []
    for pr in prs:
        merged_at = pr.get("merged_at")
        if not merged_at:
            continue
        merged = datetime.fromisoformat(merged_at.replace("Z", "+00:00"))
        if merged < since:
            continue
        created = datetime.fromisoformat(pr["created_at"].replace("Z", "+00:00"))
        durations.append((merged - created).total_seconds() / 3600.0)
    return sum(durations) / len(durations) if durations else 0.0


def compute_ci_duration(runs: list) -> float:
    """Mean wall-clock minutes a CI run takes, queue time included.

    Deliberately measured from `created_at` rather than `run_started_at`: time
    spent waiting for a runner is time the developer waits, and excluding it
    would flatter a platform that is starved of runners.
    """
    durations = []
    for run in runs:
        if run.get("conclusion") not in ("success", "failure"):
            continue
        started = datetime.fromisoformat(run["created_at"].replace("Z", "+00:00"))
        finished = datetime.fromisoformat(run["updated_at"].replace("Z", "+00:00"))
        durations.append((finished - started).total_seconds() / 60.0)
    return sum(durations) / len(durations) if durations else 0.0


def compute_build_failure_ratio(runs: list) -> float:
    """Failed CI runs as a fraction of runs that reached a verdict.

    Cancelled runs are excluded here, unlike in change failure rate: a cancelled
    run is usually a person changing their mind, not the build breaking. The two
    metrics answer different questions and deliberately count differently.
    """
    decided = [r for r in runs if r.get("conclusion") in ("success", "failure")]
    if not decided:
        return 0.0
    failures = len([r for r in decided if r["conclusion"] == "failure"])
    return failures / len(decided)


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
        # PUT, not POST. POST merges into an existing Pushgateway group and
        # leaves behind any metric no longer in the payload, so renaming
        # dora_change_failure_rate to dora_change_failure_rate_percent left 28
        # orphaned series of the old name sitting at their last value forever,
        # with nothing to ever update or expire them. PUT replaces the group,
        # which is the correct semantic here: this exporter owns
        # job=dora-exporter entirely and always publishes the full metric set
        # for a service in one call. Observed 2026-08-17.
        req = urllib.request.Request(
            url,
            data=payload.encode("utf-8"),
            method="PUT",
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


def prune_stale_services(current: set) -> None:
    """Delete Pushgateway groups for services that no longer exist.

    Pushgateway retains a pushed group until it is explicitly deleted, so a
    decommissioned service (or one that lost the idp-app topic) keeps serving
    its last DORA values indefinitely and stays on the Grafana dashboard.

    Skipped when `current` is empty: a transient GitHub API failure makes every
    service look deleted, and wiping the dashboard because a token expired is
    worse than briefly stale data.

    CloudWatch needs no equivalent — its metrics age out on their own.
    """
    if not current:
        log.warning("Skipping prune — no services discovered this run (GitHub API failure?)")
        return

    try:
        resp = requests.get(f"{PUSHGATEWAY_URL}/api/v1/metrics", timeout=15)
        resp.raise_for_status()
        groups = resp.json().get("data", [])
    except Exception as exc:
        log.warning("Could not list Pushgateway groups, skipping prune: %s", exc)
        return

    published = set()
    for group in groups:
        labels = group.get("labels", {})
        if labels.get("job") != "dora-exporter":
            continue
        svc = labels.get("service")
        if svc and svc != "all-services":
            published.add(svc)

    # The aggregate is derived from the per-service set. With no reportable
    # services it describes nothing, and is never recomputed (the aggregate push
    # is guarded on having at least one service), so it would sit on the
    # dashboard showing numbers for services that are no longer listed.
    stale = published - current
    if not current:
        stale.add("all-services")

    for svc in sorted(stale):
        url = (f"{PUSHGATEWAY_URL}/metrics/job/dora-exporter"
               f"/service/{quote(svc, safe='')}")
        try:
            r = requests.delete(url, timeout=15)
            if r.status_code in (200, 202):
                log.info("Pruned stale DORA series for removed service: %s", svc)
            else:
                log.warning("Prune failed for %s: HTTP %s", svc, r.status_code)
        except Exception as exc:
            log.warning("Prune failed for %s: %s", svc, exc)


def main():
    since = datetime.now(timezone.utc) - timedelta(hours=LOOKBACK_HOURS)
    log.info("Collecting DORA metrics since %s for org %s", since.isoformat(), GITHUB_ORG)

    repos = get_service_repos()
    all_deploy_freq, all_lead_times, all_cfr, all_mttr = [], [], [], []
    all_devex: dict = {name: [] for name in DEVEX_GAUGES}
    # Services published from inside a monorepo. They are not GitHub repos, so
    # they must be recorded here or prune_stale_services deletes each one
    # moments after it is pushed — which is exactly what happened to
    # hello-service: pushed, then "Pruned stale DORA series for removed
    # service: hello-service" in the same run, leaving Backstage with nothing
    # to query. Observed 2026-08-17.
    monorepo_services: set = set()

    for repo in repos:
        log.info("Processing repo: %s", repo)
        try:
            topics    = get_repo_topics(repo)
            team      = get_team_for_repo(repo, topics)
            runs      = get_workflow_runs(repo, since)
            prod_runs = [r for r in runs if r.get("head_branch") == "main"]

            # A monorepo deploys several services from one workflow, so publish a
            # series per service as well as the repo-level roll-up. Without this
            # every service inside this repo has no DORA series at all and its
            # Backstage entity tab is blank — which is the state hello-service
            # and all ten MCP servers were in.
            if repo in MONOREPO_REPOS:
                for svc, svc_runs in sorted(get_runs_by_service(repo, prod_runs).items()):
                    s_freq = compute_deploy_frequency(svc_runs, LOOKBACK_HOURS)
                    s_lead = compute_lead_time(svc_runs)
                    s_cfr  = compute_change_failure_rate(svc_runs)
                    s_mttr = compute_mttr(svc_runs)
                    log.info("  %s/%s (team=%s) — deploys/day=%.2f lead_time=%.1fm CFR=%.1f%% MTTR=%.1fm",
                             repo, svc, team, s_freq, s_lead, s_cfr, s_mttr)
                    push_to_gateway("dora-exporter", svc, {
                        "dora_deploy_frequency_per_day":     (s_freq, "DORA deployment frequency (deploys per day)", "gauge"),
                        "dora_lead_time_minutes":            (s_lead, "DORA lead time for changes (minutes)",        "gauge"),
                        "dora_change_failure_rate_percent":  (s_cfr,  "DORA change failure rate (percent)",          "gauge"),
                        "dora_mttr_minutes":                 (s_mttr, "DORA mean time to restore (minutes)",         "gauge"),
                    }, team=team)
                    monorepo_services.add(svc)

            deploy_freq = compute_deploy_frequency(prod_runs, LOOKBACK_HOURS)
            lead_time   = compute_lead_time(prod_runs)
            cfr         = compute_change_failure_rate(prod_runs)
            mttr        = compute_mttr(prod_runs)

            # Developer Experience. CI metrics come from the runs already fetched
            # above — all branches, not just main, because developers wait on
            # pull-request CI too. Only the pull-request query costs an extra call.
            #
            # A series is omitted rather than zeroed when nothing ran: the
            # Engineering Intelligence scoring engine reads an absent sample as
            # reduced coverage but a zero as a real measurement, so pushing 0.0
            # would claim instant CI and a flawless build rather than silence.
            devex: dict = {}
            if [r for r in runs if r.get("conclusion") in ("success", "failure")]:
                devex["devex_ci_duration_minutes"] = (
                    compute_ci_duration(runs), DEVEX_GAUGES["devex_ci_duration_minutes"], "gauge")
                devex["devex_build_failure_ratio"] = (
                    compute_build_failure_ratio(runs), DEVEX_GAUGES["devex_build_failure_ratio"], "gauge")

            cycle_time = compute_pr_cycle_time(get_recent_pull_requests(repo), since)
            if cycle_time > 0:
                devex["devex_pr_cycle_time_hours"] = (
                    cycle_time, DEVEX_GAUGES["devex_pr_cycle_time_hours"], "gauge")

            for _name, _entry in devex.items():
                all_devex[_name].append(_entry[0])

            log.info("%s (team=%s) — deploys/day=%.2f lead_time=%.1fm CFR=%.1f%% MTTR=%.1fm devex=%s",
                     repo, team, deploy_freq, lead_time, cfr, mttr,
                     {k: round(v[0], 2) for k, v in devex.items()} or "-")

            # Push to Prometheus Pushgateway (names match Grafana dashboard queries)
            push_to_gateway("dora-exporter", repo, {
                "dora_deploy_frequency_per_day": (deploy_freq, "DORA deployment frequency (deploys per day)", "gauge"),
                "dora_lead_time_minutes":        (lead_time,   "DORA lead time for changes (minutes)",        "gauge"),
                # _percent suffix is required: the Backstage DORA tab and the platform
                # DORA page both query dora_change_failure_rate_percent. This was pushed
                # as dora_change_failure_rate, so the CFR panel could never find a series
                # and rendered blank even when the exporter had just published a real
                # value. The other three names already matched. Observed 2026-08-17.
                "dora_change_failure_rate_percent": (cfr,   "DORA change failure rate (percent)",          "gauge"),
                "dora_mttr_minutes":             (mttr,        "DORA mean time to restore (minutes)",         "gauge"),
                # DevEx rides in the same push, and therefore the same Pushgateway
                # group, so prune_stale_services retires it alongside DORA when a
                # service disappears. A second job would leak stale series.
                **devex,
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
            "dora_change_failure_rate_percent": (agg_cfr,      "DORA change failure rate (percent)",          "gauge"),
            "dora_mttr_minutes":             (agg_mttr,        "DORA mean time to restore (minutes)",         "gauge"),
            # Only aggregate a DevEx series when at least one service reported it,
            # so "nothing merged anywhere this window" stays absent rather than
            # becoming a platform-wide zero.
            **{
                name: (sum(values) / len(values), DEVEX_GAUGES[name], "gauge")
                for name, values in all_devex.items() if values
            },
        })

        if not SKIP_CLOUDWATCH:
            agg_dims = [{"Name": "Aggregate", "Value": "all-services"}, {"Name": "Team", "Value": "all"}]
            put_cloudwatch("DeployFrequency",   agg_deploy_freq, "None",    agg_dims)
            put_cloudwatch("LeadTime",          agg_lead_time,   "Count",   agg_dims)
            put_cloudwatch("ChangeFailureRate", agg_cfr,         "Percent", agg_dims)
            put_cloudwatch("MTTR",              agg_mttr,        "Count",   agg_dims)

        log.info("Published aggregate metrics for %d services.", len(repos))

    # Reconcile: drop anything Pushgateway still holds that is no longer a service.
    prune_stale_services(set(repos) | monorepo_services)


if __name__ == "__main__":
    main()
