# ${{ values.name }}

${{ values.description }}

A Python FastAPI service that calls Claude and reports every model call to Langfuse.

## Architecture

```
POST /chat
   │
   ├─ with_generation()          opens a Langfuse `generation` span
   │     └─ anthropic.messages.create(model=${{ values.model }}, effort=${{ values.effort }})
   │
   ├─ record_usage()             token counts → Langfuse computes cost
   └─ Prometheus counters        llm_tokens_total, llm_request_duration_seconds
```

The span is exported over OTLP/HTTP protobuf directly to Langfuse — no collector in between. When
the caller is a KAgent agent, its `traceparent` header nests this span under the agent's LLM
trace, so one waterfall covers the whole chain.

## Operational characteristics

- **Model calls take seconds to minutes**, not milliseconds, and scale with the effort level.
  `llm_request_duration_seconds` uses buckets sized for that; the HTTP histogram does not.
- **Tracing is best-effort.** A Langfuse outage does not affect request serving — spans are
  dropped, the endpoint keeps answering.
- **Cost is driven by tokens, not requests.** Watch `llm_tokens_total` rather than request rate;
  one long conversation can cost more than a thousand short ones.

## See also

- [Runbook](runbooks/service.md) — what to do when it breaks
- [ADR 0001](adr/0001-initial-decisions.md) — why it is built this way
- The **Langfuse** tab on this service's Backstage entity page
