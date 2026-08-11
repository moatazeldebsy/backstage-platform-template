# Langfuse tracing — Go

Node.js and Python get a ready-made module from this template; Go gets these instructions, because
Go LLM services on this platform are rare enough that a maintained module would rot unnoticed.

The mechanics are the same as the platform's own instrumentation
(`services/*-mcp-server/src/telemetry.ts` in the platform repo) — read that if anything below is
ambiguous.

## 1. Dependencies

```bash
go get go.opentelemetry.io/otel \
       go.opentelemetry.io/otel/sdk \
       go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp
```

Use `otlptracehttp`, **not** `otlptracegrpc`. Langfuse's ingest is HTTP/protobuf.

## 2. Set up the provider

```go
package telemetry

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/url"
	"os"
	"strconv"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.24.0"
)

// Init returns a shutdown func. It is a no-op when LANGFUSE_OTLP_ENDPOINT is
// unset, which is what makes it safe to deploy before the namespace has the
// Langfuse credentials.
func Init(ctx context.Context, serviceName string) (func(context.Context) error, error) {
	endpoint := os.Getenv("LANGFUSE_OTLP_ENDPOINT")
	pk := os.Getenv("LANGFUSE_PUBLIC_KEY")
	sk := os.Getenv("LANGFUSE_SECRET_KEY")
	if endpoint == "" || pk == "" || sk == "" {
		return func(context.Context) error { return nil }, nil
	}

	// otlptracehttp takes a host and a path separately, so the full URL from
	// LANGFUSE_OTLP_ENDPOINT has to be split. Do NOT let the SDK derive the
	// path: it appends /v1/traces to whatever base it is given, which turns
	// Langfuse's documented complete path into a silent 404.
	u, err := url.Parse(endpoint)
	if err != nil {
		return nil, fmt.Errorf("parsing LANGFUSE_OTLP_ENDPOINT: %w", err)
	}

	auth := base64.StdEncoding.EncodeToString([]byte(pk + ":" + sk))
	opts := []otlptracehttp.Option{
		otlptracehttp.WithEndpoint(u.Host),
		otlptracehttp.WithURLPath(u.Path),
		otlptracehttp.WithHeaders(map[string]string{"Authorization": "Basic " + auth}),
	}
	if u.Scheme == "http" {
		opts = append(opts, otlptracehttp.WithInsecure())
	}

	exp, err := otlptracehttp.New(ctx, opts...)
	if err != nil {
		return nil, err
	}

	if name := os.Getenv("OTEL_SERVICE_NAME"); name != "" {
		serviceName = name
	}

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exp),
		sdktrace.WithResource(resource.NewWithAttributes(
			semconv.SchemaURL,
			semconv.ServiceName(serviceName),
		)),
		// Parent-based: dropping a child of a sampled parent leaves a hole in
		// the waterfall.
		sdktrace.WithSampler(sdktrace.ParentBased(sdktrace.TraceIDRatioBased(sampleRate()))),
	)
	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.TraceContext{})

	return tp.Shutdown, nil
}

func sampleRate() float64 {
	r, err := strconv.ParseFloat(os.Getenv("LANGFUSE_SAMPLE_RATE"), 64)
	if err != nil || r < 0 || r > 1 {
		return 1.0
	}
	return r
}
```

Call `Init` once at startup and defer the returned shutdown — without the flush, the last few
calls before a pod termination never leave the process.

## 3. Span attributes

Wrap each model call in a span carrying these attributes. The `langfuse.*` keys are what Langfuse's
OTLP ingest maps onto its own model; rename them and the span arrives untyped, with no cost or
token accounting.

| Attribute | Value |
|---|---|
| `langfuse.observation.type` | `generation` |
| `langfuse.trace.name` | `<service>.<operation>` |
| `langfuse.trace.tags` | `${{ values.repoName }}` — what the Backstage Langfuse tab filters on |
| `gen_ai.request.model` | the model id you passed to the provider |
| `gen_ai.usage.input_tokens` | from the provider response |
| `gen_ai.usage.output_tokens` | from the provider response |
| `langfuse.observation.input` | prompt — **only when `LANGFUSE_CAPTURE_IO=true`** |
| `langfuse.observation.output` | completion — same condition |
| `langfuse.user.id` / `langfuse.session.id` | if you have them |

Truncate captured input and output at 8,000 characters, and gate them on `LANGFUSE_CAPTURE_IO`;
everyone with Langfuse access can read whatever you record.

Set span status to `codes.Error` and call `RecordError` on failure — otherwise failed calls show as
successes in Langfuse.

## 4. Verify

See `langfuse/README.md` in this directory for the namespace label, the Helm values patch and the
catalog annotation. Once deployed, traces show on the service's **Langfuse** tab in Backstage.
