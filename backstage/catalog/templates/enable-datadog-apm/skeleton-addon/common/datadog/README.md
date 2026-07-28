# Datadog APM & Monitoring

This service has been wired up for Datadog. See `datadog/${{ values.language }}-instrumentation.md`
in this same directory for the language-specific APM setup.

## 1. Unified service tagging

Set these environment variables wherever the service runs (Helm values, deployment manifest, `.env`):

| Variable | Value |
|---|---|
| `DD_ENV` | `${{ values.ddEnv }}` |
| `DD_SERVICE` | `${{ values.repoName }}` |
| `DD_VERSION` | your release version (e.g. the image tag) |
| `DD_SITE` | `${{ values.datadogSite }}` |
| `DD_AGENT_HOST` | node IP of the Datadog Agent DaemonSet (Kubernetes Downward API `status.hostIP`) |
| `DD_TRACE_AGENT_PORT` | `8126` |

If this service is deployed via `helm/service-template` (the platform's generic Helm chart), set in
your `helm-values-*.yaml`:

```yaml
datadog:
  enabled: true
  env: "${{ values.ddEnv }}"
  service: "${{ values.repoName }}"
  version: "" # set to your release/image tag
```

## 2. Catalog annotations (for the Datadog tab in Backstage)

Add these to this repo's `catalog-info.yaml` under `metadata.annotations` so the entity page's
Datadog tab shows dashboard/monitor/SLO status:

```yaml
metadata:
  annotations:
    datadoghq.com/dashboard-url: "${{ values.dashboardUrl }}"
    datadoghq.com/monitor-tag: "service:${{ values.repoName }}"
    datadoghq.com/site: "app.${{ values.datadogSite }}"
```

(Remove the `dashboard-url` line if you left the dashboard URL parameter blank — add it later once
you've created a dashboard.)

## 3. Cluster-wide setup already in place

The Datadog Agent and API/App keys are already provisioned platform-wide — no new secrets are
needed for this service. See `docs/sre-reliability.md` in the platform repo, section
"Datadog Infra Observability & APM", for how the Agent, dd-trace on Backstage itself, and the
catalog UI plugin fit together.
