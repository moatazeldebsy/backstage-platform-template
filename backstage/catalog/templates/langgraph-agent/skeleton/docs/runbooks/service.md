# Runbook — ${{ values.name }}

## Triage order

Start at `/ready` — it reports configuration without calling the model API:

```bash
kubectl exec deploy/${{ values.name }} -n services-dev -- \
  curl -s localhost:${{ values.port }}/ready
```

```json
{"status":"ready","mcp_tools":54,"tracing":true}
```

`mcp_tools: 0` means the AI Gateway is unreachable or serving nothing; `tracing: false` points at
the `langfuse-otel` secret. Both are covered below.

(This block previously showed an `api_key_configured` field that `/ready` has never returned.)

## `/chat` returns 503, `/healthz` is fine

Model calls are not getting through. This agent holds no provider key, so the cause is never a
secret in this namespace — it is the AI Gateway, or the gateway's own credential.

```bash
kubectl get deployment ai-gateway -n ml-platform     # is it running at all?
kubectl logs -n ml-platform deploy/ai-gateway | grep 'protocol=llm' | tail
```

- **No `protocol=llm` lines** — the request never arrived. Check `ANTHROPIC_BASE_URL` on this
  pod; it should be `http://ai-gateway.ml-platform.svc.cluster.local:3000`.
- **`http.status=401` with `gen_ai.provider.name=anthropic`** — the request reached the gateway
  and the gateway reached Anthropic, which rejected *its* credential. Fix `ai-gateway-llm-keys`
  in `ml-platform`, not anything here.
- **Gateway pod absent** — the platform was installed with `--skip-gateway`. Every agent and
  every scaffolded LLM app depends on it.

An empty tool list is the same gateway, different symptom — see the MCP section below.

## `/chat` returns 429 or 503 intermittently

Upstream rate limiting or a provider fault. The service passes 429 and 5xx through unchanged so
callers can retry with backoff; a 502 means the request itself was rejected and retrying will not
help.

Check `llm_tokens_total` — a sudden climb usually means one caller looping, not organic growth.

## `/chat` returns 422

Either the request body failed validation (empty or oversized `message`), or the model declined
the request. The second case is logged as `"model refused the request"`. A refusal arrives as a
successful HTTP 200 from the API with an empty content list, so it is a content outcome, not an
error — do not retry the same prompt.

## No traces in Langfuse

Work down this list:

1. **Is the endpoint in the pod?**
   ```bash
   kubectl exec deploy/${{ values.name }} -n services-dev -- printenv LANGFUSE_OTLP_ENDPOINT
   ```
   Empty → `secret/langfuse-otel` is missing from the namespace, or the pod predates it.

2. **Is the secret there?**
   ```bash
   kubectl get secret langfuse-otel -n services-dev
   ```
   Missing → label the namespace and re-run the distribution from the platform repo:
   ```bash
   kubectl label namespace services-dev idp.io/langfuse=enabled
   ./scripts/bootstrap-ai.sh --langfuse-keys-only
   kubectl rollout restart deployment/${{ values.name }} -n services-dev
   ```

3. **Is Langfuse itself up?**
   ```bash
   kubectl get pods -n ml-platform -l app.kubernetes.io/instance=langfuse
   ```

4. **Startup log.** The service logs `{"msg": "startup", ..., "tracing": true|false}` on boot, and
   `telemetry.py` warns when the endpoint is set but the key pair is missing.

## Traces appear but carry no prompt or completion text

`LANGFUSE_CAPTURE_IO=false`, the default. Flip it in `helm-values-*.yaml` only if the data is safe
for everyone with Langfuse access to read. Captured values are truncated at 8,000 characters.

## Traces appear but show no cost

Cost is computed from token counts plus the model id. If `record_usage()` stopped being called —
usually because someone restructured `/chat` — the span shows latency and nothing else. Check that
`gen_ai.usage.input_tokens` is present on the span in Langfuse.

## Responses are truncated mid-sentence

`ANTHROPIC_MAX_TOKENS` bounds thinking **and** response text together, so raising the effort level
without raising the token cap truncates the answer. Raise `ANTHROPIC_MAX_TOKENS`, or lower
`ANTHROPIC_EFFORT`.

## Rollback

```bash
kubectl rollout undo deployment/${{ values.name }} -n services-dev
```

Or revert the image tag in `services/${{ values.name }}/helm-values-aws.yaml` in the platform repo
and let ArgoCD reconcile.
