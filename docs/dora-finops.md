# DORA Metrics & FinOps

The platform surfaces engineering performance (DORA) and cloud cost (FinOps) data directly inside Backstage — no separate dashboard login required.

---

## DORA Entity Tab

Every `Component` catalog entity has a **DORA** tab at `/catalog/default/component/<name>/dora`.

### What It Shows

| Card | Metric | Elite threshold |
|---|---|---|
| Deploy Frequency | Deployments per day (7-day rolling) | ≥ 1/day |
| Lead Time | Median commit-to-deploy time | < 1 hour |
| Change Failure Rate | % of deployments causing incidents | < 5% |
| MTTR | Mean time to restore after failure | < 1 hour |

Each card shows:
- Current value with an **Elite / High / Medium / Low** performance band badge (colour-coded green → red)
- A 7-day SVG sparkline trend

### Data Source

Metrics are queried from Prometheus via the `/api/proxy/prometheus` Backstage proxy:

```
/api/v1/query?query=idp_deploy_frequency{service="<name>"}
/api/v1/query?query=idp_lead_time_seconds{service="<name>"}
/api/v1/query?query=idp_change_failure_rate{service="<name>"}
/api/v1/query?query=idp_mttr_seconds{service="<name>"}
```

If Prometheus is unreachable or the service has no data yet, the tab falls back to realistic demo values with a yellow banner.

### Prerequisites

- Prometheus proxy must be reachable: `http://prometheus.idp.local` (local) or the in-cluster DNS endpoint (AWS)
- The Prometheus proxy is configured in `backstage/app-config.local.yaml` (`/api/proxy/prometheus`) and `backstage/app-config.aws.yaml`
- DORA metrics are pushed by the DORA exporter CronJob — see `local/observability/dora/dora-exporter.py` (local) and `aws/observability/dora/dora-exporter.py` (AWS) for the metric definitions
- All metrics carry a `team=` label (see [Team dimension](#team-dimension) below)

### Implementation

The tab is implemented in `backstage/app/packages/app/src/extensions.tsx`. It registers as a `EntityContent` extension under the route path `dora` and queries Prometheus on component mount.

---

## FinOps Cost Overview

The **FinOps** entity tab is visible on every `Component` entity and shows the cloud cost breakdown for that service's namespace.

### Features

**Date-range selector:**
- Last 24 hours
- Last 7 days (default)
- Last 30 days

**Breakdown mode:**
- By Namespace
- By Team (uses `team` label on workloads)
- By Container

**Stacked bar chart** — SVG chart showing cost per time bucket, coloured by namespace. Hover for per-namespace breakdown.

**Cost table:**

| Column | What it shows |
|---|---|
| Namespace / Team / Container | Resource identifier |
| CPU cost | Estimated CPU spend |
| Memory cost | Estimated RAM spend |
| PV cost | Persistent Volume spend |
| Efficiency % | `(requested - idle) / requested` — green ≥ 80%, amber 50–79%, red < 50% |
| Trend bar | Mini stacked bar: CPU / RAM / PV split |

A **Totals row** at the bottom aggregates across all visible rows.

**Fallback mode:** When OpenCost is unreachable, the tab shows realistic demo data with a yellow banner indicating that data is not live.

### Data Source

Cost data is fetched from OpenCost via the `/api/proxy/opencost` Backstage proxy:

```
/model/allocation?window=<range>&aggregate=<dimension>
```

OpenCost is deployed in the `monitoring` namespace and configured in `backstage/app-config.local.yaml`.

### Implementation

The FinOps tab is implemented alongside the DORA tab in `backstage/app/packages/app/src/extensions.tsx`. Both tabs are registered in the same `createFrontendPlugin` block.

---

## Grafana Dashboards

For deeper analysis, DORA and FinOps data is also available in Grafana:

| Dashboard | URL | What it covers |
|---|---|---|
| DORA Metrics | http://grafana.idp.local/d/dora | Deploy frequency, lead time, CFR, MTTR trends per service |
| QA KPI | http://grafana.idp.local/d/qa | Test pass rates, flakiness, coverage trends |
| AI Platform Cost | http://grafana.idp.local/d/ai-platform | MCP tool call metrics, AI API cost per team |
| OpenCost | http://grafana.idp.local/d/opencost | Cluster cost by namespace, workload, and node |

---

## Team dimension

All four DORA metrics carry a `team=` Prometheus label so dashboards can be
filtered or grouped by team:

```promql
# Deploy frequency for a specific team
dora_deploy_frequency_per_day{team="payments"}

# Average lead time across all teams
avg by (team) (dora_lead_time_minutes)
```

### How team is resolved (in priority order)

1. `TEAM_MAP` env var — a JSON map of `{"repo-name": "team-name"}` stored in AWS
   Secrets Manager under `idp-mvp/backstage` (key: `TEAM_MAP`).
2. GitHub repo topic `team:<name>` — tag any service repo with topic `team:payments`
   and the exporter picks it up automatically.
3. Falls back to `team="unknown"` if neither is configured.

### Configure TEAM_MAP (AWS)

```bash
# Add team mappings to Secrets Manager
CURRENT=$(aws secretsmanager get-secret-value \
  --secret-id idp-mvp/backstage --query SecretString --output text)

echo "$CURRENT" | python3 -c "
import json, sys
s = json.load(sys.stdin)
s['TEAM_MAP'] = json.dumps({'orders-api': 'payments', 'auth-service': 'platform'})
print(json.dumps(s))
" | aws secretsmanager update-secret \
    --secret-id idp-mvp/backstage --secret-string file:///dev/stdin
```

### Configure TEAM_MAP (local)

Uncomment the `TEAM_MAP` block in `local/observability/dora/dora-cronjob.yaml` and
create a ConfigMap:

```bash
kubectl create configmap dora-team-map -n monitoring \
  --from-literal=TEAM_MAP='{"orders-api":"payments"}'
```

---

## DORA Exporter

The DORA exporter (`local/observability/dora/dora-exporter.py` locally, `aws/observability/dora/dora-exporter.py` on AWS) is a Python script running as a Kubernetes CronJob. It:

1. Queries the GitHub API for deployment events per service repo
2. Calculates the four DORA metrics per service over a rolling window
3. Pushes metrics to Prometheus Pushgateway with `service=<name>` labels

The exporter runs every 15 minutes (local) or every 5 minutes (AWS). Local metrics also accept synthetic data via `./scripts/seed-qa-metrics.sh` for demo purposes.

---

## Team Cost Budgets

### What it is

Monthly USD budget limits are declared as annotations on Backstage `Group` entities in `backstage/catalog/catalog-info.yaml` and `backstage/catalog/qa-catalog.yaml`. Actual spend is queried from OpenCost (via `/allocation/compute?window=month&aggregate=label:team`) every 15 minutes by the tech-insights-exporter (`observability/tech-insights-exporter/exporter.py`). Canonical budget values are also stored in `kubernetes/finops/team-budgets-configmap.yaml`.

### Prometheus metrics

| Metric | Labels | Description |
|--------|--------|-------------|
| `idp_team_budget_usd_monthly` | `{team}` | Configured monthly budget in USD |
| `idp_team_actual_cost_usd_monthly` | `{team}` | Actual spend from OpenCost (updated every 15 min) |
| `idp_team_budget_utilization_ratio` | `{team}` | Ratio of actual to budget (`actual / budget`) |

### AlertManager alerts

Two PrometheusRules in the `team-cost-budgets` group fire when teams approach or exceed their budget:

| Alert | Condition | Severity | Destination |
|-------|-----------|----------|-------------|
| `TeamBudgetWarning` | Utilisation > 80% | Warning | Slack `#platform-alerts` |
| `TeamBudgetExceeded` | Utilisation > 100% | Critical | PagerDuty + Slack |

See the [Cost Budget Exceeded runbook](runbooks/cost-budget-exceeded.md) for remediation steps.

### Viewing budgets in Grafana and Prometheus

**Grafana:**

The **AI Platform Cost** dashboard (`http://grafana.idp.local/d/ai-platform`) includes a per-team budget vs actual panel. For a dedicated view, query the metrics directly in Explore:

```promql
# Budget utilisation per team (as percentage)
idp_team_budget_utilization_ratio * 100

# Teams over budget
idp_team_budget_utilization_ratio > 1.0
```

**Prometheus:**

```
http://prometheus.idp.local/graph?g0.expr=idp_team_budget_utilization_ratio
```

### How to update a team's budget

1. Edit the `idp.io/cost-budget-monthly-usd` annotation on the Group entity:

   ```yaml
   # backstage/catalog/catalog-info.yaml (or qa-catalog.yaml)
   metadata:
     name: backend-team
     annotations:
       idp.io/cost-budget-monthly-usd: "800"
   ```

2. Update the matching entry in `kubernetes/finops/team-budgets-configmap.yaml`.
3. Commit and push. The exporter picks up the new value on the next 15-minute polling cycle.

### Current budget values

| Team | Monthly budget (USD) |
|------|---------------------|
| platform-team | $2,000 |
| ml-team | $1,500 |
| data-team | $800 |
| backend-team | $600 |
| frontend-team | $400 |
| android-team | $300 |
| ios-team | $300 |
| qa-team | $200 |
