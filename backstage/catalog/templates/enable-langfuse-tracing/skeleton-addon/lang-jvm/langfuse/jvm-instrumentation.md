# Langfuse tracing — JVM (Java / Kotlin)

Node.js and Python get a ready-made module from this template; the JVM gets these instructions.
The mechanics are identical — an OTLP/HTTP protobuf exporter pointed at Langfuse with HTTP Basic
auth, and `langfuse.*` span attributes.

## Option A — the OpenTelemetry Java agent (no code change)

The agent auto-instruments HTTP clients and most frameworks. It cannot label spans as Langfuse
generations on its own, so you get latency and errors but **not** token counts or cost. Good enough
if you only want to see that calls are happening.

Add to your container command:

```
-javaagent:/otel/opentelemetry-javaagent.jar
```

and set, alongside the variables already injected by `helm-values-patch.yaml`:

| Variable | Value |
|---|---|
| `OTEL_TRACES_EXPORTER` | `otlp` |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | `$(LANGFUSE_OTLP_ENDPOINT)` |
| `OTEL_EXPORTER_OTLP_TRACES_HEADERS` | `Authorization=Basic <base64 of publicKey:secretKey>` |
| `OTEL_METRICS_EXPORTER` / `OTEL_LOGS_EXPORTER` | `none` |

Two traps here, both silent:

- The protocol must be the literal string `http/protobuf`. Anything else — including the
  intuitive `http` — falls back to gRPC and every span is dropped with no error. This is the same
  trap KAgent has.
- Use `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (the traces-specific variable, taken verbatim), not
  `OTEL_EXPORTER_OTLP_ENDPOINT` (a base, onto which `/v1/traces` is appended — yielding
  `.../otel/v1/traces/v1/traces` and a 404).

`OTEL_EXPORTER_OTLP_TRACES_HEADERS` needs the base64 of the key pair, which the injected Secret
does not pre-compute. Build it in an init step or an entrypoint wrapper:

```sh
export OTEL_EXPORTER_OTLP_TRACES_HEADERS="Authorization=Basic $(printf '%s:%s' "$LANGFUSE_PUBLIC_KEY" "$LANGFUSE_SECRET_KEY" | base64 | tr -d '\n')"
```

The `tr -d '\n'` is load-bearing: GNU `base64` wraps at 76 columns, and a newline inside a header
value makes every export fail with a 400.

## Option B — manual spans (full Langfuse model)

Add `io.opentelemetry:opentelemetry-sdk` and
`io.opentelemetry:opentelemetry-exporter-otlp`, then wrap each model call:

```java
Span span = tracer.spanBuilder("chat").setSpanKind(SpanKind.CLIENT).startSpan();
try (Scope scope = span.makeCurrent()) {
    span.setAttribute("langfuse.observation.type", "generation");
    span.setAttribute("langfuse.trace.name", serviceName + ".chat");
    // The tag the Backstage Langfuse tab filters on.
    span.setAttribute("langfuse.trace.tags", serviceName);
    span.setAttribute("gen_ai.request.model", modelId);

    var response = callTheModel(prompt);

    span.setAttribute("gen_ai.usage.input_tokens", response.inputTokens());
    span.setAttribute("gen_ai.usage.output_tokens", response.outputTokens());
    return response;
} catch (Exception e) {
    span.recordException(e);
    span.setStatus(StatusCode.ERROR, e.getMessage());
    throw e;
} finally {
    span.end();
}
```

Only set `langfuse.observation.input` / `langfuse.observation.output` when `LANGFUSE_CAPTURE_IO` is
`true`, and truncate both at 8,000 characters — anyone with Langfuse access can read them.

Gate the whole setup on `LANGFUSE_OTLP_ENDPOINT` being non-empty so the service still starts
(untraced) before the namespace has the credentials.

## Verify

See `langfuse/README.md` in this directory for the namespace label, the Helm values patch and the
catalog annotation.
