# ADR-0003: Incident records, and where their state lives

**Status:** Accepted · **Date:** 2026-08-14

## Context

The platform had most of an incident pipeline: Prometheus rules with
`runbook_url` on all 14 alerts, Alertmanager routing to PagerDuty and Slack,
`agent-event-router` opening a GitHub issue per critical alert, and an
`incident-agent` with five MCP tools.

It had never opened a single incident issue.

Alertmanager stops at the first matching route whose `continue` is false — and
false is the default. The critical and warning Slack routes omitted it, which
terminated every alert before it reached the `agent-event-router` route. The
router was deployed, configured with `GITHUB_TOKEN` and `INCIDENT_REPO`, and
receiving nothing.

Underneath that were five more problems:

- Dedupe state was an in-memory `Map`, so a restart mid-incident re-filed a
  duplicate issue for every still-firing alert.
- PagerDuty incidents and GitHub issues had no shared identifier.
- `incident:needs-postmortem` was applied by the router and read by nothing, so
  the 48-hour SLA was enforced by memory.
- Four severity vocabularies: Prometheus `critical/warning/info`, the issue
  labels, `P1/P2/P3` in the postmortem template, and "Sev-1" in the agent prompt.
- No incident view in Backstage at all — the activity feed's incident rows were
  hardcoded, so it showed a fictional outage on a cluster that had never had one.

## Decision

**GitHub issues are the source of truth. The in-memory map becomes a cache over
them.**

A ConfigMap or CRD was rejected: `agent-event-router` runs with
`readOnlyRootFilesystem` and no Kubernetes RBAC, `incident-mcp-server` already
reads incidents out of GitHub issues, and a second store would immediately
disagree with the first.

Per-incident state rides in a machine-readable marker in the issue body, so every
consumer — `rehydrate()`, the postmortem workflow, the MCP tools, the Backstage
UI — reads structured JSON rather than parsing a prose table.

**One severity vocabulary (P1/P2/P3)**, mapped at the single point where alerts
enter the system. Issues carry both `severity:P1` and `severity:critical` for one
release, because `get_open_incidents` filters on the Prometheus value and
breaking it would take the agent's triage down with it.

**PagerDuty correlation refuses to guess.** Alertmanager owns the PD dedup key
and will not let us set it, so matching is on alertname **and** service, and an
ambiguous match is skipped. Two services alerting with the same alertname
simultaneously is exactly when a wrong backlink does the most harm.

## Consequences

Two failure modes are accepted deliberately:

- **GitHub's search index is eventually consistent**, so two alerts inside that
  window can still double-file. The cache absorbs the common case.
- **A search outage is treated as not-found.** That risks one duplicate; treating
  it as found would silently drop a real incident. The duplicate is the safer
  failure.

`INCIDENT_SEVERITIES` defaults to `critical` alone. Filing for warnings on a
noisy cluster buries the repository, and that should be an explicit operator
decision rather than an inherited default.

The postmortem renderer is **deliberately deterministic**. It fills in
identifiers, a timeline reconstructed from the issue and its comments, and the
MTTR arithmetic — then leaves every judgement field as `_TODO_`. It does not
attempt a narrative: a plausible-sounding *wrong* root cause in a postmortem is
worse than an empty heading. An AI-drafted narrative is a reasonable follow-up,
not the default.

MTTR is computed over **resolved incidents only**. Counting an open incident as
zero duration would flatter the number — the kind of metric bug that survives for
years because it always looks fine.

## Known gap

SLO burn-rate alerts depend on Sloth recording rules, and **no Sloth operator
runs in-cluster** — the `PrometheusServiceLevel` CRD is inert and the rules are
vendored. Editing an SLO source without the `sloth` binary on PATH silently
changes nothing. A burn-rate alert that never fires is not the same as a healthy
error budget. See `docs/sre-reliability.md`.

## References

- `services/agent-event-router/src/incidents.ts` — the store, taxonomy, correlation
- `observability/alertmanager/alertmanager-config.yaml` — the route ordering
- `.github/workflows/postmortem.yml`, `scripts/render-postmortem.py`
- `docs/runbooks/incident-severity.md` — the vocabulary mapping
