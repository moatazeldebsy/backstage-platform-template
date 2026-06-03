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
- DORA metrics are pushed by the DORA exporter CronJob — see `observability/dora-exporter/` for the metric definitions

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

## DORA Exporter

The DORA exporter (`observability/dora-exporter/`) is a Python script running as a Kubernetes CronJob. It:

1. Queries the GitHub API for deployment events per service repo
2. Calculates the four DORA metrics per service over a rolling window
3. Pushes metrics to Prometheus Pushgateway with `service=<name>` labels

The exporter runs every 15 minutes (local) or every 5 minutes (AWS). Local metrics also accept synthetic data via `./scripts/seed-qa-metrics.sh` for demo purposes.
