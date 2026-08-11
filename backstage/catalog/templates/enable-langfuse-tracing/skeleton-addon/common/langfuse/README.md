# Langfuse LLM Tracing

This service has been wired for Langfuse, the platform's LLM observability backend. See the
language-specific file in this same directory for how to call the instrumentation from your code.

## 1. Environment variables

These are injected by the `envFrom` block in `helm-values-patch.yaml` — you do not set them by
hand. They are listed here so you know what the instrumentation reads.

| Variable | Source | Meaning |
|---|---|---|
| `LANGFUSE_OTLP_ENDPOINT` | `secret/langfuse-otel` | Full OTLP traces URL. **Tracing is off whenever this is unset.** |
| `LANGFUSE_PUBLIC_KEY` | `secret/langfuse-otel` | Project API key (HTTP Basic username) |
| `LANGFUSE_SECRET_KEY` | `secret/langfuse-otel` | Project API key (HTTP Basic password) |
| `OTEL_SERVICE_NAME` | your Helm values | Service name on the trace. Defaults to `${{ values.repoName }}`. |
| `LANGFUSE_CAPTURE_IO` | your Helm values | `true` records prompts and completions. Currently `${{ values.captureIo }}`. |
| `LANGFUSE_SAMPLE_RATE` | your Helm values | Fraction of root traces recorded, `0.0`–`1.0`. Currently `${{ values.sampleRate }}`. |

`LANGFUSE_OTLP_ENDPOINT` is a **complete** URL ending in `/api/public/otel/v1/traces`, not a base
URL. Do not pass it as `OTEL_EXPORTER_OTLP_ENDPOINT`: exporters append `/v1/traces` to that
variable, which produces `.../otel/v1/traces/v1/traces` and a silent 404 with no spans delivered.

## 2. Helm values

Merge the contents of `helm-values-patch.yaml` into this repo's `helm-values-local.yaml` and
`helm-values-aws.yaml`. It adds an `envFrom` reference to `secret/langfuse-otel` plus the three
tuning variables above.

## 3. Get the credentials into your namespace

The Langfuse project keys live in the `ml-platform` namespace and Kubernetes Secrets do not cross
namespaces. From the **platform repo**, once per namespace:

```bash
kubectl label namespace ${{ values.namespace }} idp.io/langfuse=enabled
./scripts/bootstrap-ai.sh --langfuse-keys-only
```

That creates `secret/langfuse-otel` in `${{ values.namespace }}`. Workloads already running there
need a restart to pick it up:

```bash
kubectl rollout restart deployment/${{ values.repoName }} -n ${{ values.namespace }}
```

On AWS you can instead commit `external-secret.yaml` and let External Secrets pull the same pair
from AWS Secrets Manager. Locally there is no External Secrets install, so the label mechanism is
the only path there.

Verify it landed:

```bash
kubectl get secret langfuse-otel -n ${{ values.namespace }} \
  -o jsonpath='{.data.LANGFUSE_OTLP_ENDPOINT}' | base64 -d
```

## 4. Catalog annotation (for the Langfuse tab in Backstage)

Add this to this repo's `catalog-info.yaml` under `metadata.annotations` so the entity page grows a
**Langfuse** tab showing this service's traces, cost and latency:

```yaml
metadata:
  annotations:
    langfuse.com/service-name: "${{ values.repoName }}"
```

The value must match the Langfuse trace tag the instrumentation sets, which defaults to
`OTEL_SERVICE_NAME` — leave both as `${{ values.repoName }}` unless you have a reason not to.

## 5. Platform setup already in place

Langfuse itself, its Postgres/ClickHouse/S3 backing stores and the `idp-agents` project are
provisioned platform-wide. No new secrets or infrastructure are created for this service. See
`docs/ai-assistant.md` in the platform repo for the full picture, and the **AI Observability** page
in Backstage for the platform-wide view.

## Troubleshooting

**No traces at all.** Check the endpoint actually reached the pod —
`kubectl exec deploy/${{ values.repoName }} -n ${{ values.namespace }} -- printenv LANGFUSE_OTLP_ENDPOINT`.
Empty means the Secret is missing or the pod predates it; re-run step 3 and restart.

**Traces appear with no prompt or completion text.** That is `LANGFUSE_CAPTURE_IO=false`, the
default. Flip it in your Helm values if the data is safe to record.

**Spans are dropped silently.** Confirm the exporter is the protobuf one, not the JSON one — the
generated module uses OTLP/HTTP protobuf because that is what Langfuse's ingest and KAgent's
exporter both speak. Mixing encodings fails without an error message.
