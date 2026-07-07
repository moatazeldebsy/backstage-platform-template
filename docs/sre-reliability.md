# SRE & Reliability

This page covers the reliability practices and tooling shipped as part of the platform's SRE programme (Sprints 1–7). All items described here are already deployed and active.

---

## SLOs and Error Budgets

### Overview

Service Level Objectives are defined using [Sloth](https://sloth.dev/), a YAML-based SLO generator that produces multi-window, multi-burn-rate Prometheus alerting rules from a simple specification. Sloth SLOs ship as the platform default for all new services via the `slo-definition` Backstage template.

### Defining an SLO

Use the Backstage scaffolder to add an SLO to any service:

1. Go to **Create** → **SLO Definition**
2. Fill in service name, target (e.g. `99.5`), and latency threshold
3. The template writes a Sloth YAML to `observability/slo/<service>-slos.yaml` and opens a PR

Example reference: `observability/slo/hello-service-slos.yaml` — 99.5% availability, p99 < 500 ms.

### Multi-window burn-rate alerts

The platform ships two alert groups in `observability/alertmanager/prometheus-rules.yaml`:

| Group | Alert | Window | Burn rate | Action |
|-------|-------|--------|-----------|--------|
| `slo-burn-rate` | `SLOErrorBudgetFastBurn` | 1 h / 5 min | > 14× | Page on-call (Critical) |
| `slo-burn-rate` | `SLOErrorBudgetSlowBurn` | 6 h / 30 min | > 2× | Slack warning |
| `dora-anomalies` | `HighChangeFailureRate` | 24 h | CFR > 10% | Slack warning |

### Viewing SLO status in Grafana

```
http://grafana.idp.local/d/slo
```

The SLO dashboard shows current error budget burn rate, remaining budget percentage, and a 30-day trend per service.

---

## PodDisruptionBudgets

### What ships by default

The golden-path Helm chart (`helm/service-template/`) includes a `PodDisruptionBudget` with `minAvailable: 1` enabled by default. This prevents voluntary disruptions (node drains, rolling upgrades) from taking all replicas offline simultaneously.

### What `minAvailable: 1` means in practice

- During a `kubectl drain`, Kubernetes will not evict the last running pod of a service.
- Rolling deployments always keep at least one healthy replica serving traffic.
- For single-replica services this is a no-op — scale to at least 2 replicas to benefit fully.

### Overriding

```yaml
# helm-values-local.yaml or helm-values-aws.yaml
podDisruptionBudget:
  enabled: true
  minAvailable: 2   # increase for critical services
```

---

## Blameless Postmortem Process

The platform includes a blameless postmortem template at [`docs/templates/postmortem.md`](templates/postmortem.md).

### Process

1. For any P1 or P2 incident, a postmortem must be filed within **48 hours** of resolution.
2. Copy the template into `docs/postmortems/<YYYY-MM-DD>-<incident-title>.md`.
3. Fill in the five sections: timeline, impact, root cause, contributing factors, action items.
4. Open a PR — the platform team reviews within 24 hours.
5. Action items are tracked as GitHub Issues with the `postmortem` label.

**Key principle:** The template explicitly focuses on *what happened* and *what we change*, not *who was at fault*.

---

## OPA Cost-Tag Enforcement

The `require-cost-tags` OPA/Gatekeeper policy (`kubernetes/policies/require-cost-tags.yaml`) was upgraded from `warn` mode to **`deny` mode** in Sprint 1. This means:

- Any workload (Deployment, StatefulSet, DaemonSet) without `idp.io/cost-centre` and `team` labels will be **rejected at admission**.
- The golden-path Helm chart pre-populates both labels from template values so scaffolded services pass automatically.
- To add tags to a brownfield workload:

```yaml
metadata:
  labels:
    team: backend-team
    idp.io/cost-centre: backend
```

Verify a manifest before applying:

```bash
helm template my-svc helm/service-template --values helm-values.yaml | \
  kubectl apply --dry-run=server -f -
```

---

## Log Aggregation — Loki + Promtail

### Architecture

Promtail runs as a DaemonSet and ships all pod stdout/stderr to Loki. Grafana queries Loki via the built-in Loki datasource.

| Environment | Loki location |
|-------------|--------------|
| Local (Kind) | `local/observability/loki/` — single-binary mode |
| AWS (EKS) | `aws/observability/loki/` — scalable distributed mode |

### Querying logs in Grafana Explore

```
http://grafana.idp.local/explore
```

Example queries:

```logql
# All logs from a service
{app="hello-service"}

# Error logs only
{namespace="services-dev"} |= "error"

# Audit log entries from IDP MCP Server
{app="idp-mcp-server"} |= "[AUDIT]" | json

# Follow logs for a specific pod
{pod="contract-mcp-server-abc123"}
```

### TraceID linking to Tempo

Loki is configured with a **derived field** that detects `traceId` in log lines and renders it as a clickable link to the matching Tempo trace. This means you can jump from a log line directly to the distributed trace that generated it.

---

## Distributed Tracing — Grafana Tempo

### Endpoints

| Endpoint | Protocol | Use |
|----------|----------|-----|
| `http://tempo.idp.local` | HTTP | Grafana UI, health checks |
| `tempo.idp.local:4317` | gRPC (OTLP) | SDK instrumentation |
| `tempo.idp.local:4318` | HTTP (OTLP) | SDK instrumentation, curl testing |

### Instrumenting a service

**Node.js / TypeScript:**

```typescript
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://tempo.idp.local:4318/v1/traces',
  }),
});
sdk.start();
```

**Go:**

```go
import "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"

exporter, _ := otlptracehttp.New(ctx,
  otlptracehttp.WithEndpoint("tempo.idp.local:4318"),
  otlptracehttp.WithInsecure(),
)
```

Set the `OTEL_SERVICE_NAME` environment variable to your service name so traces appear labelled correctly in Tempo.

### Viewing traces

```
http://grafana.idp.local/explore
```

Select the **Tempo** datasource and search by service name, trace ID, or span attributes.

---

## PagerDuty Escalation

### Configuration

PagerDuty is wired into AlertManager as a receiver for **Critical** severity alerts. Configure it by setting the integration key in `local/.env`:

```bash
PAGERDUTY_INTEGRATION_KEY=your-events-api-v2-key
```

The AlertManager config is at `observability/alertmanager/alertmanager-config.yaml`.

### What pages on-call

| Alert | Trigger condition | Destination |
|-------|-------------------|-------------|
| `SLOErrorBudgetFastBurn` | Error budget burns > 14× | PagerDuty (Critical) |
| `PodCrashLooping` | Pod restart count high | PagerDuty (Critical) |
| `HighHTTP5xxRate` | 5xx rate > 5% | PagerDuty (Critical) |
| `TeamBudgetExceeded` | Monthly cost > 100% budget | PagerDuty (Critical) |

### What goes to Slack only

Slow-burn SLO alerts, `HighMemoryUsage` (Warning), `TeamBudgetWarning` (80%), and `ScaffoldServiceHighRate` route to Slack `#platform-alerts` without paging.

---

## Canary Deployments — Argo Rollouts

### Opting in

To enable canary deployments for a service, set in your `helm-values.yaml` (or `helm-values-local.yaml`):

```yaml
rollout:
  enabled: true
  canary:
    steps:
      - setWeight: 20
      - pause: { duration: 5m }
      - setWeight: 50
      - pause: { duration: 10m }
```

The golden-path Helm chart converts the `Deployment` to an Argo `Rollout` resource when `rollout.enabled: true`.

### Auto-rollback via ClusterAnalysisTemplate

A platform-wide `ClusterAnalysisTemplate` named `http-error-rate` is deployed at `local/argocd/argo-rollouts-values.yaml` and `aws/argocd/argo-rollouts-values.yaml`. It automatically aborts and rolls back the canary if:

- 5xx error rate exceeds **1%** during any analysis interval, or
- p99 latency exceeds **500 ms**

### Scaffolding a canary service

Use the **Canary Deployment** Backstage template (Create → Canary Deployment) to add canary configuration to an existing service. The template writes `helm-values-staging.yaml` and wires the analysis template.

### Accessing Argo Rollouts UI

```bash
kubectl argo rollouts dashboard -n services-dev
```

Or via ingress: `http://argo-rollouts.idp.local` (requires `bootstrap-ai.sh`).

---

## Multi-Environment GitOps Promotion

### Flow

```
dev (auto)  →  staging (PR)  →  prod (manual approval)
```

- **dev**: Every merge to `main` auto-deploys to the `services-dev` namespace via ArgoCD (`idp-services` ApplicationSet).
- **staging**: A CI job (`promote-to-staging`) opens a PR that updates `helm-values-staging.yaml` with the new image SHA. Merging the PR triggers ArgoCD sync to `services-staging` (`idp-services-staging` ApplicationSet).
- **prod**: Once the staging deploy passes its smoke test (`smoke-test-staging`), the `promote-to-production` job opens a PR that updates `helm-values-prod.yaml`. A human must merge it — there is no auto-merge to production. Merging triggers ArgoCD sync to `services-prod` (`idp-services-prod` ApplicationSet).

Both `idp-services-staging` and `idp-services-prod` use a `files` generator (not `directories`) in `aws/argocd/app-of-apps.yaml` — an Application is only created once the corresponding `helm-values-<env>.yaml` actually exists for a service, so services that haven't been promoted yet don't produce broken/OutOfSync Applications. The prod ApplicationSet also disables `selfHeal` so an incident rollback via `argocd app rollback` isn't immediately reverted by auto-sync.

### How `promote-to-staging` works

The CI job runs a smoke test after the dev deploy completes. If the smoke test passes, it:

1. Checks out the platform repo
2. Updates the `image.tag` in `helm-values-staging.yaml`
3. Opens a PR titled `chore: promote <service> <tag> to staging`

The PR must be reviewed and merged manually — there is no auto-merge for staging.

### Smoke test in CI

The `smoke-test` job runs after the dev deploy and hits `GET /healthz` on the deployed service. A non-200 response fails the CI run and blocks the staging promotion PR from being opened.

---

## Per-Team Cost Budgets

### Overview

Monthly USD budgets are declared as annotations on Backstage `Group` entities and enforced via PrometheusRules. Actual costs are queried from OpenCost every 15 minutes by the tech-insights-exporter.

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

### Prometheus metrics

| Metric | Description |
|--------|-------------|
| `idp_team_budget_usd_monthly{team}` | Configured monthly budget |
| `idp_team_actual_cost_usd_monthly{team}` | Actual OpenCost spend (updated every 15 min) |
| `idp_team_budget_utilization_ratio{team}` | `actual / budget` — alerts fire at 0.8 and 1.0 |

### Alerts

| Alert | Threshold | Severity |
|-------|-----------|----------|
| `TeamBudgetWarning` | Utilisation > 80% | Warning → Slack |
| `TeamBudgetExceeded` | Utilisation > 100% | Critical → PagerDuty |

See the [Cost Budget Exceeded runbook](runbooks/cost-budget-exceeded.md) for remediation steps.

### Updating a team's budget

1. Edit the annotation in `backstage/catalog/catalog-info.yaml` or `backstage/catalog/qa-catalog.yaml`:
   ```yaml
   metadata:
     annotations:
       idp.io/cost-budget-monthly-usd: "1000"
   ```
2. Update the matching entry in `kubernetes/finops/team-budgets-configmap.yaml`.
3. Commit and push — the exporter picks up the new value on the next 15-minute cycle.

---

## KAgent Guardrails and Audit Log

### Structured audit log

Every MCP tool call on the `idp-mcp-server` and `contract-mcp-server` emits a structured `[AUDIT]` line to stdout:

```json
[AUDIT] {"ts":"2026-06-09T12:00:00Z","server":"idp-mcp-server","action":"scaffold_service_requested","agent":"idp-assistant","service":"demo-svc","template":"python-service","dry_run":false}
```

**Fields:**

| Field | Description |
|-------|-------------|
| `ts` | ISO-8601 timestamp |
| `server` | MCP server name (`idp-mcp-server`, `contract-mcp-server`) |
| `action` | Tool-specific action identifier |
| `agent` | Agent ID (from `X-Agent-ID` header or `User-Agent`) |
| Tool-specific fields | e.g. `service`, `template`, `dry_run`, `provider`, `version` |

### Querying audit logs in Loki

```logql
{app="idp-mcp-server"} |= "[AUDIT]" | json
{app="contract-mcp-server"} |= "[AUDIT]" | json | action="register_contract_requested"
```

### Per-agent metrics in Prometheus/Grafana

```promql
# Tool call rate per agent
rate(mcp_agent_tool_calls_total{server="idp-mcp-server"}[5m])

# Error rate per tool
rate(mcp_tool_calls_total{outcome="error"}[5m]) /
rate(mcp_tool_calls_total[5m])
```

The Grafana **AI Platform** dashboard (`http://grafana.idp.local/d/ai-platform`) shows these metrics broken down by server, tool, and agent.

### dry_run mode

Pass `dry_run: true` when calling `scaffold_service` to get a preview of what would be created without actually creating anything:

```
User: "dry run: scaffold a Go service called test-svc"
```

The agent detects the phrase "dry run" and passes `dry_run: true` to the tool, which returns a preview JSON without making any Backstage scaffolder calls.

### KAgent system-prompt guardrails

`kubernetes/kagent/idp-agent.yaml` includes the following guardrail rules:

| Rule | Behaviour |
|------|-----------|
| 9 | Announce to the user before performing any destructive operation (scaffold, deploy) |
| 10 | Support `dry_run: true` — use it when the user says "dry run", "preview", or "what would happen" |
| 11 | Self-check: if `scaffold_service` has been called more than 3 times in the same session, pause and ask the user to confirm intent |

### Agent rate alerts

Two PrometheusRules in the `kagent-guardrails` group alert on abnormal agent behaviour:

| Alert | Condition | Action |
|-------|-----------|--------|
| `ScaffoldServiceHighRate` | > 5 scaffold calls in 10 minutes | Warning → Slack |
| `McpToolErrorRateHigh` | > 50% error rate on any MCP tool | Warning → Slack |

See the [KAgent Guardrails runbook](runbooks/kagent-guardrails.md) for investigation steps.
