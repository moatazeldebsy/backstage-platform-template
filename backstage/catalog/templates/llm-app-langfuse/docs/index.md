# LLM App (Python + Langfuse)

Scaffolds a Python FastAPI service that calls Claude and reports every model call to the
platform's Langfuse instance. The instrumentation is wired at scaffold time, so the first request
the service serves after deployment already produces a trace with the prompt, completion, token
counts, cost and latency.

## How to use

1. Open Backstage → **Create**
2. Find **LLM App (Python + Langfuse)** and click **Choose**
3. Name the service, pick a model and effort level, choose a repository and deployment target
4. Click **Create**

## What you get

```
src/main.py            FastAPI app: /chat, /healthz, /ready, /metrics
src/telemetry.py       OpenTelemetry → Langfuse module (see below)
tests/test_main.py     pytest suite with the Anthropic client mocked
Dockerfile             python:3.13-slim, non-root
helm-values-*.yaml     local / dev / aws, with the langfuse-otel envFrom already present
catalog-info.yaml      carries langfuse.com/service-name — drives the Langfuse entity tab
.github/workflows/ci.yml  ruff, mypy, pip-audit, Trivy, pytest with a 70% coverage gate
```

## Two secrets, two different mechanisms

**No Anthropic API key needed.** Model calls route through the platform's AI Gateway, which
holds the provider credential and injects it upstream — so a scaffolded service answers as soon
as it is deployed, with no secret for you to create, hold or rotate.

To bypass the gateway (running outside the cluster, or pinning to a different provider account),
set `ANTHROPIC_BASE_URL=https://api.anthropic.com` and supply your own `ANTHROPIC_API_KEY`.

**The Langfuse credentials are the platform's.** They are minted in-cluster and copied into every
namespace labelled `idp.io/langfuse=enabled` as `secret/langfuse-otel`. `services-dev` already
carries that label, so a service deployed there needs nothing extra. For a different namespace:

```bash
kubectl label namespace <ns> idp.io/langfuse=enabled
./scripts/bootstrap-ai.sh --langfuse-keys-only
```

Both are referenced with `optional: true`, so a missing secret never blocks the pod from starting.
Without the API key the service starts and returns 500 from `/chat`; without Langfuse it serves
traffic normally and records nothing.

## Instrumentation

`src/telemetry.py` is byte-identical to the module shipped by the `enable-langfuse-tracing`
template, so an app scaffolded here and an existing service instrumented by that template behave
the same and can be diffed directly. It uses raw OpenTelemetry with the OTLP/HTTP **protobuf**
exporter — the same encoding KAgent uses — so agent → service traces nest correctly.

Every model call goes through `with_generation()`, which records a Langfuse `generation`
observation carrying the model id, the trace tag the Backstage tab filters on, and (when
`LANGFUSE_CAPTURE_IO=true`) the prompt and completion. `record_usage()` reports the token counts
Langfuse needs to compute cost — a generation span without them shows latency but no cost.

## No `idp` CLI equivalent — deliberate

`idp scaffold service` supports three runtimes (`nodejs`, `python`, `go`) and there is no
`llm-app` type. That matches every other specialist service template here — `ruby-service`,
`jvm-service`, `react-frontend`, `mcp-server`, `model-serving-api` and `ai-agent-kagent` have no
CLI counterpart either. Adding a fourth CLI type would widen the CLI ↔ Backstage drift surface for
no user benefit. This is a decision, not an oversight: do not "fix" it in a drift audit.

## Source

Template definition: [`template.yaml`](../template.yaml)
