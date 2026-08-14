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

**Already done for you.** The same pull request that added this file also merged these
annotations into `catalog-info.yaml`, so the entity page's Datadog tab reads them
directly:

```yaml
metadata:
  annotations:
    datadoghq.com/dashboard-url: "${{ values.dashboardUrl }}"
    datadoghq.com/monitor-tag: "service:${{ values.repoName }}"
    datadoghq.com/site: "app.${{ values.datadogSite }}"
```

Nothing to paste. If a key was already set in your `catalog-info.yaml`, it was left
alone rather than overwritten — check the diff on this PR to see exactly what changed.

`dashboard-url` is omitted when you left the dashboard parameter blank; re-run this
template with a URL, or add the line yourself once you have created a dashboard.

## 3. Cluster-wide setup already in place

The Datadog Agent and API/App keys are already provisioned platform-wide — no new secrets are
needed for this service. See `docs/sre-reliability.md` in the platform repo, section
"Datadog Infra Observability & APM", for how the Agent, dd-trace on Backstage itself, and the
catalog UI plugin fit together.
