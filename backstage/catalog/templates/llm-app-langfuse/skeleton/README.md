# ${{ values.name }}

${{ values.description }}

A Python FastAPI service that calls Claude, with Langfuse tracing wired in. Scaffolded from the
IDP `llm-app-langfuse` golden path.

## Run it locally

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# Outside the cluster the gateway is not reachable, so go direct:
export ANTHROPIC_BASE_URL=https://api.anthropic.com
export ANTHROPIC_API_KEY=sk-ant-...
uvicorn src.main:app --reload --port ${{ values.port }}

curl -s localhost:${{ values.port }}/chat \
  -H 'content-type: application/json' \
  -d '{"message": "What is an internal developer platform?"}' | jq
```

Tracing stays off locally unless you point it at Langfuse — see below.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/chat` | Send a message to Claude. Body: `{"message": "...", "user_id": "...", "session_id": "..."}` |
| `GET` | `/healthz` | Liveness |
| `GET` | `/ready` | Readiness — also reports the model, the `llm_base_url` it will call, and whether tracing is configured |
| `GET` | `/metrics` | Prometheus metrics, including `llm_tokens_total` and `llm_request_duration_seconds` |

`/ready` deliberately does **not** call the model API. A readiness probe that costs a token per
check would bill continuously and take the pod down on a provider blip.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_BASE_URL` | the AI Gateway | Where model calls go. Defaults to `http://ai-gateway.ml-platform.svc.cluster.local:3000`. Set it to `https://api.anthropic.com` to bypass the gateway (needed when running outside the cluster). |
| `ANTHROPIC_API_KEY` | — | **Not required in-cluster.** The gateway holds the provider credential and injects it upstream. Only needed when you point `ANTHROPIC_BASE_URL` straight at Anthropic. |
| `ANTHROPIC_MODEL` | `${{ values.model }}` | Model id. Complete as written — never append a date suffix. |
| `ANTHROPIC_EFFORT` | `${{ values.effort }}` | `low`–`max`. How much the model thinks before answering. |
| `ANTHROPIC_MAX_TOKENS` | `8192` | Caps thinking **and** response text together. Raise it with effort. |
| `SYSTEM_PROMPT` | see `src/main.py` | The service's persona and constraints. |
| `LANGFUSE_OTLP_ENDPOINT` | — | From `secret/langfuse-otel`. **Tracing is off whenever this is unset.** |
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` | — | From `secret/langfuse-otel`. |
| `OTEL_SERVICE_NAME` | `${{ values.name }}` | Service name on the trace, and the tag the Backstage tab filters on. |
| `LANGFUSE_CAPTURE_IO` | `${{ values.captureIo }}` | `true` records prompts and completions. |
| `LANGFUSE_SAMPLE_RATE` | `${{ values.sampleRate }}` | Fraction of root traces recorded, 0.0–1.0. |

## Secrets

**You do not need an Anthropic key.** Model calls go through the platform's AI Gateway, which
holds the provider credential and injects it upstream — so there is no `sk-ant-` value for this
service to create, store or rotate. This used to be a required manual step before every
scaffolded LLM app would answer at all.

The gateway does not check inbound credentials today. When it does, the per-team virtual key
arrives the same way `langfuse-otel` does — distributed by the platform, not minted by you.

**`langfuse-otel` — the platform's.** Copied into every namespace labelled
`idp.io/langfuse=enabled`. `services-dev` already carries that label, so nothing is needed there.
For any other namespace, from the platform repo:

```bash
kubectl label namespace <ns> idp.io/langfuse=enabled
./scripts/bootstrap-ai.sh --langfuse-keys-only
```

Both are mounted with `optional: true`, so a missing secret degrades one thing rather than
crashlooping the pod.

## Tracing against Langfuse from your laptop

```bash
export LANGFUSE_OTLP_ENDPOINT=${{ values.langfuseUrl }}/api/public/otel/v1/traces
export LANGFUSE_PUBLIC_KEY=$(kubectl get secret langfuse-init -n ml-platform \
  -o jsonpath='{.data.LANGFUSE_INIT_PROJECT_PUBLIC_KEY}' | base64 -d)
export LANGFUSE_SECRET_KEY=$(kubectl get secret langfuse-init -n ml-platform \
  -o jsonpath='{.data.LANGFUSE_INIT_PROJECT_SECRET_KEY}' | base64 -d)
```

The endpoint is a **complete** URL. Do not pass it as `OTEL_EXPORTER_OTLP_ENDPOINT`: exporters
append `/v1/traces` to that variable, producing `.../otel/v1/traces/v1/traces` and a silent 404.

## Where the traces show up

- **Per service** — the **Langfuse** tab on this service's Backstage entity page, filtered by the
  `langfuse.com/service-name` annotation in `catalog-info.yaml`.
- **Platform-wide** — the **AI Observability** page in Backstage.
- **Raw** — Langfuse's own UI at `${{ values.langfuseUrl }}`.

Traces appear with latency and token counts. Prompt and completion text appear only when
`LANGFUSE_CAPTURE_IO=true` — leave it off unless the data is safe for anyone with Langfuse access
to read.

## Tests

```bash
pip install -r requirements.txt pytest httpx pytest-cov
pytest -v --cov=src
```

No test makes a network call or spends a token — the Anthropic client is mocked in
`tests/conftest.py`. CI enforces 70% coverage.

## A note on `src/telemetry.py`

Scaffolded from the platform's shared module and byte-identical to the one the
`enable-langfuse-tracing` template ships. It is yours to edit, but a CI job warns when it drifts
from the platform copy — that check is a warning, not a gate. Read the design notes at the top of
the file before changing the exporter or the span attributes; the `langfuse.*` attribute keys are
what Langfuse's ingest maps onto its own model, and renaming them costs you cost and token
accounting.
