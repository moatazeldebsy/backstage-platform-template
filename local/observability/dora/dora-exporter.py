#!/usr/bin/env python3
"""
DORA Metrics Exporter — local variant
Queries GitHub Actions API for workflow run history across all service repos,
computes the four DORA metrics, and pushes them to a Prometheus Pushgateway.

Runs as a Kubernetes CronJob every 15 minutes.

Environment variables:
  GITHUB_TOKEN      — GitHub PAT with repo + actions:read scope
  GITHUB_ORG        — GitHub organisation (e.g. moatazeldebsy)
  PUSHGATEWAY_URL   — Prometheus Pushgateway endpoint (default: http://prometheus-pushgateway.monitoring.svc.cluster.local:9091)
  LOOKBACK_HOURS    — how far back to query (default: 24)
"""
import os
import logging
from datetime import datetime, timezone, timedelta

from urllib.parse import quote
import requests
from prometheus_client import CollectorRegistry, Gauge, push_to_gateway

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

GITHUB_TOKEN       = os.environ["GITHUB_TOKEN"]
GITHUB_ORG         = os.environ.get("GITHUB_ORG", "moatazeldebsy")
BACKSTAGE_URL      = os.environ.get("BACKSTAGE_URL", "")
BACKSTAGE_TOKEN    = os.environ.get("BACKSTAGE_TOKEN", "")
# When true, only report services that exist in the Backstage catalog. Without
# it the exporter reports every GitHub repo carrying the idp-app topic, which
# includes repos that were scaffolded once and never registered (or since
# removed from) the portal — they show on the DORA dashboard as services the
# platform does not actually know about.
REQUIRE_CATALOG    = os.environ.get("REQUIRE_CATALOG_ENTRY", "true").lower() != "false"
PUSHGATEWAY_URL    = os.environ.get(
    "PUSHGATEWAY_URL",
    "http://prometheus-pushgateway.monitoring.svc.cluster.local:9091",
)
LOOKBACK_HOURS     = int(os.environ.get("LOOKBACK_HOURS", "24"))
# REPO_FILTER_TOPIC: only track repos that have this GitHub topic (set by scaffold templates).
# Defaults to "idp-app" which all IDP scaffold templates apply via publish:github.
REPO_FILTER_TOPIC  = os.environ.get("REPO_FILTER_TOPIC", "idp-app")
# REPO_INCLUDE: explicit comma-separated allowlist that overrides topic filtering.
# Example: "hello-service,my-go-svc,my-node-svc"
REPO_INCLUDE       = os.environ.get("REPO_INCLUDE", "")

GH_HEADERS = {
    "Authorization": f"Bearer {GITHUB_TOKEN}",
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
}


def gh_get(url: str, params: dict = None, max_pages: int | None = None) -> list:
    """Paginate through a GitHub API endpoint, optionally stopping after N pages.

    `max_pages` exists for the pull-request query, which has no `since` filter:
    a busy repo can hold thousands of closed PRs, and walking all of them every
    15 minutes would burn the rate limit for a mean that a recent sample already
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


def get_service_repos() -> list[str]:
    """Return IDP-managed service repos using the following priority:

    1. REPO_INCLUDE env var — explicit comma-separated allowlist, overrides everything.
    2. REPO_FILTER_TOPIC env var (default: "idp-app") — GitHub topic filter.
       All IDP scaffold templates set this topic via publish:github, so only
       scaffolded services are included. Unrelated repos that happen to have a
       ci.yml are excluded automatically.
    3. Fallback — repos that contain .github/workflows/build-and-deploy.yml,
       used when REPO_FILTER_TOPIC is explicitly set to an empty string.
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

    # Fallback: repos with build-and-deploy.yml (IDP deploy workflow)
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
    log.info("Found %d service repos via workflow check: %s", len(service_repos), service_repos)
    return service_repos


def get_workflow_runs(repo: str, since: datetime) -> list:
    since_str = since.strftime("%Y-%m-%dT%H:%M:%SZ")
    return gh_get(
        f"https://api.github.com/repos/{GITHUB_ORG}/{repo}/actions/runs",
        {"per_page": 100, "created": f">={since_str}"}
    )


# Developer Experience series. Names are the contract with the Engineering
# Intelligence Prometheus collector (packages/backend/src/modules/
# engineeringIntelligence/prometheus.ts) — change one and change the other.
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
    Returns 0.0 when nothing merged in the window, which the scoring engine
    reads as "no sample" only if the metric is absent — so callers must skip
    pushing rather than push a zero. See main().
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
        # True DORA lead time: from the commit timestamp to when the deploy completed.
        # head_commit.timestamp is the moment the commit was pushed; updated_at is deploy done.
        commit_ts = (run.get("head_commit") or {}).get("timestamp") or run["created_at"]
        commit_time = datetime.fromisoformat(commit_ts.replace("Z", "+00:00"))
        deploy_time = datetime.fromisoformat(run["updated_at"].replace("Z", "+00:00"))
        lead_times.append((deploy_time - commit_time).total_seconds() / 60.0)
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


def push_metrics(service: str, deploy_freq: float, lead_time: float, cfr: float, mttr: float,
                 devex: dict | None = None):
    """Push per-service DORA and Developer Experience metrics to Pushgateway.

    DevEx metrics ride in the same push, and therefore the same Pushgateway
    group, so `prune_stale_services` retires them alongside the DORA ones when a
    service disappears. A second job would need its own pruning and would
    eventually leak stale series.

    `devex` is omitted rather than zeroed when a repo produced no pull requests
    or no CI runs in the window. The Engineering Intelligence scoring engine
    treats an absent sample as reduced coverage but reads a zero as a real
    measurement, so pushing 0.0 here would claim a repo has instant CI and a
    flawless build rather than that nothing ran.
    """
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

    for name, help_text in DEVEX_GAUGES.items():
        if devex and name in devex:
            Gauge(name, help_text, ["service"], registry=registry) \
                .labels(service=service).set(devex[name])

    push_to_gateway(PUSHGATEWAY_URL, job="dora-exporter",
                    grouping_key=grouping, registry=registry)


def push_aggregate_metrics(repos: list, all_deploy_freq: list, all_lead_times: list,
                           all_cfr: list, all_mttr: list, all_devex: dict | None = None):
    """Push org-wide aggregate DORA metrics to Prometheus Pushgateway."""
    registry = CollectorRegistry()
    grouping = {"service": "all-services"}

    Gauge("dora_deploy_frequency_per_day",
          "Deployments per day (successful prod deploys)",
          ["service"], registry=registry).labels(service="all-services").set(sum(all_deploy_freq))

    Gauge("dora_lead_time_minutes",
          "Average lead time from commit to prod deploy (minutes)",
          ["service"], registry=registry).labels(service="all-services").set(
              sum(all_lead_times) / len(all_lead_times) if all_lead_times else 0.0)

    Gauge("dora_change_failure_rate_percent",
          "Percentage of prod deploys that resulted in failure",
          ["service"], registry=registry).labels(service="all-services").set(
              sum(all_cfr) / len(all_cfr) if all_cfr else 0.0)

    Gauge("dora_mttr_minutes",
          "Mean time to restore after a failed prod deploy (minutes)",
          ["service"], registry=registry).labels(service="all-services").set(
              sum(all_mttr) / len(all_mttr) if all_mttr else 0)

    # Only aggregate a DevEx series when at least one service reported it, so
    # "nothing merged anywhere this window" stays absent instead of becoming a
    # platform-wide zero.
    for name, help_text in DEVEX_GAUGES.items():
        values = (all_devex or {}).get(name) or []
        if values:
            Gauge(name, help_text, ["service"], registry=registry) \
                .labels(service="all-services").set(sum(values) / len(values))

    push_to_gateway(PUSHGATEWAY_URL, job="dora-exporter",
                    grouping_key=grouping, registry=registry)


def prune_stale_services(current: set, discovery_ok: bool) -> None:
    """Delete Pushgateway groups for services that no longer exist.

    Pushgateway is a persistent store, not a scrape target: a group pushed once
    is kept until explicitly deleted. So a service that is decommissioned — or
    simply loses the idp-app topic — keeps serving its last DORA values forever,
    and the Grafana dashboard lists services that are no longer on the platform.
    Observed with 10 deleted demo services still reporting.

    `discovery_ok` reports whether GitHub discovery itself succeeded, and is
    deliberately separate from `current` being empty. A transient API failure
    makes every service look deleted, and wiping the dashboard because a token
    expired is far worse than briefly stale data. But zero services *after* the
    catalog filter is a legitimate result — everything discovered was unknown to
    Backstage — and must still prune, or the phantom services stay on the
    dashboard forever.
    """
    if not discovery_ok:
        log.warning("Skipping prune — GitHub discovery failed this run.")
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
        # all-services is the org-wide aggregate, not a real service.
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


def get_catalog_services() -> set:
    """Service identifiers known to the Backstage catalog.

    Returns both entity names and the repo half of any github.com/project-slug
    annotation, because the exporter discovers services by *repo* name while the
    catalog keys them by *entity* name, and the two do not always match.

    An empty set means "could not determine" — callers must not treat that as
    "nothing is registered", or a Backstage outage would blank the dashboard.
    """
    if not BACKSTAGE_URL:
        log.warning("BACKSTAGE_URL not set — cannot cross-check the catalog.")
        return set()

    headers = {"Authorization": f"Bearer {BACKSTAGE_TOKEN}"} if BACKSTAGE_TOKEN else {}
    try:
        resp = requests.get(
            f"{BACKSTAGE_URL}/api/catalog/entities",
            params={"filter": "kind=Component", "limit": 500},
            headers=headers, timeout=30,
        )
        resp.raise_for_status()
        entities = resp.json()
    except Exception as exc:
        log.warning("Could not read the Backstage catalog: %s", exc)
        return set()

    known = set()
    for entity in entities:
        meta = entity.get("metadata", {})
        name = meta.get("name")
        if name:
            known.add(name)
        slug = (meta.get("annotations") or {}).get("github.com/project-slug", "")
        if "/" in slug:
            known.add(slug.split("/", 1)[1])

    log.info("Backstage catalog knows %d service identifiers", len(known))
    return known


def main():
    since = datetime.now(timezone.utc) - timedelta(hours=LOOKBACK_HOURS)
    log.info("Collecting DORA metrics since %s for org %s", since.isoformat(), GITHUB_ORG)
    log.info("Pushing to Pushgateway at %s", PUSHGATEWAY_URL)

    repos = get_service_repos()
    discovered = list(repos)

    if REQUIRE_CATALOG:
        catalog = get_catalog_services()
        if catalog:
            kept = [r for r in repos if r in catalog]
            dropped = [r for r in repos if r not in catalog]
            if dropped:
                log.info("Skipping %d repo(s) absent from the Backstage catalog: %s",
                         len(dropped), dropped)
            repos = kept
        else:
            # Empty means the catalog could not be read, not that it is empty.
            log.warning("Catalog unavailable — reporting all discovered repos this run.")

    all_deploy_freq: list[float] = []
    all_lead_times:  list[float] = []
    all_cfr:         list[float] = []
    all_mttr:        list[float] = []
    all_devex: dict[str, list[float]] = {name: [] for name in DEVEX_GAUGES}

    for repo in repos:
        log.info("Processing repo: %s", repo)
        try:
            runs      = get_workflow_runs(repo, since)
            prod_runs = [r for r in runs if r.get("head_branch") == "main"]

            deploy_freq = compute_deploy_frequency(prod_runs, LOOKBACK_HOURS)
            lead_time   = compute_lead_time(prod_runs)
            cfr         = compute_change_failure_rate(prod_runs)
            mttr        = compute_mttr(prod_runs)

            # Developer Experience. CI metrics come from the runs already
            # fetched above — all branches, not just main, because developers
            # wait on pull-request CI too. Only the pull-request query costs an
            # extra call.
            devex: dict[str, float] = {}
            decided = [r for r in runs if r.get("conclusion") in ("success", "failure")]
            if decided:
                devex["devex_ci_duration_minutes"] = compute_ci_duration(runs)
                devex["devex_build_failure_ratio"] = compute_build_failure_ratio(runs)

            merged = [p for p in get_recent_pull_requests(repo) if p.get("merged_at")]
            cycle_time = compute_pr_cycle_time(merged, since)
            if cycle_time > 0:
                devex["devex_pr_cycle_time_hours"] = cycle_time

            push_metrics(repo, deploy_freq, lead_time, cfr, mttr, devex)

            log.info("%s — deploys/day=%.2f lead_time=%.1fm CFR=%.1f%% MTTR=%.1fm "
                     "pr_cycle=%s ci=%s fail_ratio=%s",
                     repo, deploy_freq, lead_time, cfr, mttr,
                     f"{devex['devex_pr_cycle_time_hours']:.1f}h" if "devex_pr_cycle_time_hours" in devex else "-",
                     f"{devex['devex_ci_duration_minutes']:.1f}m" if "devex_ci_duration_minutes" in devex else "-",
                     f"{devex['devex_build_failure_ratio']:.2f}" if "devex_build_failure_ratio" in devex else "-")

            for name, value in devex.items():
                all_devex[name].append(value)

            all_deploy_freq.append(deploy_freq)
            all_lead_times.append(lead_time)
            all_cfr.append(cfr)
            all_mttr.append(mttr)

        except Exception as exc:
            log.warning("Failed to process %s: %s", repo, exc)

    if all_deploy_freq:
        push_aggregate_metrics(repos, all_deploy_freq, all_lead_times, all_cfr, all_mttr, all_devex)
        log.info("Published aggregate metrics for %d services.", len(repos))

    # Reconcile: drop anything Pushgateway still holds that is no longer a
    # reportable service. `discovered` is the pre-filter list, so a legitimate
    # empty result after catalog filtering still prunes.
    prune_stale_services(set(repos), discovery_ok=bool(discovered))


if __name__ == "__main__":
    main()
