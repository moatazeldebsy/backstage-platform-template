# Enable Langfuse LLM Tracing

Langfuse is the platform's LLM observability backend: it records every model call as a trace with
its prompt, completion, token counts, cost and latency. KAgent agents and the platform's MCP
servers already export to it. This template extends that to **your** service.

## How to use

1. Open Backstage → **Create**
2. Find **Enable Langfuse LLM Tracing** and click **Choose**
3. Pick the target service, its repository, its runtime and its Kubernetes namespace
4. Click **Create** — a PR is opened against the target repository

## What lands in the PR

| File | Purpose |
|---|---|
| `langfuse/README.md` | Env vars, the namespace label command, the catalog annotation |
| `langfuse/helm-values-patch.yaml` | The `envFrom` block to merge into your `helm-values-*.yaml` |
| `langfuse/external-secret.yaml` | AWS-only GitOps alternative to the label mechanism |
| `langfuse/telemetry.ts` / `telemetry.py` | Runnable OpenTelemetry module (Node.js / Python) |
| `langfuse/<lang>-instrumentation.md` | Setup steps for Go, JVM and Ruby |

## How credentials reach your service

Langfuse authenticates OTLP ingest with a project API key pair. The pair is minted **in-cluster**
by the Langfuse headless init into `secret/langfuse-init` in the `ml-platform` namespace, and
Kubernetes Secrets are namespace-scoped — so it has to be copied into yours.

The platform does that by label:

```bash
kubectl label namespace <your-namespace> idp.io/langfuse=enabled
./scripts/bootstrap-ai.sh --langfuse-keys-only
```

That writes `secret/langfuse-otel` into the namespace with `LANGFUSE_OTLP_ENDPOINT`,
`LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY`. The `envFrom` block in the generated Helm values
patch is what injects them into your pods. Re-run the command whenever you label a new namespace.

On AWS the same pair is also mirrored to AWS Secrets Manager at `idp-mvp/langfuse/project-keys`,
so `langfuse/external-secret.yaml` is available if you would rather have External Secrets pull it
through GitOps than have a script push it.

## One shared project, many services

Every service reports into the single `idp-agents` Langfuse project, exactly as the platform's own
MCP servers do. Services are told apart by the OpenTelemetry `service.name` resource attribute and
by a Langfuse trace tag carrying the service name — that tag is what the per-service **Langfuse**
tab in Backstage filters on. There is no per-service project or key pair to manage.

## Safety

The generated module is **disabled by default**. With `LANGFUSE_OTLP_ENDPOINT` unset it installs no
tracer provider, no exporter and no patching, so merging the PR before the namespace is labelled
cannot change how the service behaves.

Prompt and completion capture (`LANGFUSE_CAPTURE_IO`) is off unless you opt in at scaffold time.
Turn it on only when you are sure the service never handles personal or sensitive data — anyone
with Langfuse access can read what it records. Captured values are truncated at 8,000 characters.

## Source

Template definition: [`template.yaml`](../template.yaml)
