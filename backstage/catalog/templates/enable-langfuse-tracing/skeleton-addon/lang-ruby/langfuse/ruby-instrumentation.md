# Langfuse tracing — Ruby

Node.js and Python get a ready-made module from this template; Ruby gets these instructions. The
mechanics are identical — an OTLP/HTTP protobuf exporter pointed at Langfuse with HTTP Basic auth,
and `langfuse.*` span attributes.

## 1. Gems

```ruby
# Gemfile
gem 'opentelemetry-sdk'
gem 'opentelemetry-exporter-otlp'   # HTTP/protobuf — what Langfuse ingests
```

## 2. Set up the provider

```ruby
# config/initializers/langfuse.rb (Rails) or an equivalent boot hook
require 'base64'
require 'opentelemetry/sdk'
require 'opentelemetry/exporter/otlp'

endpoint   = ENV['LANGFUSE_OTLP_ENDPOINT'].to_s
public_key = ENV['LANGFUSE_PUBLIC_KEY'].to_s
secret_key = ENV['LANGFUSE_SECRET_KEY'].to_s

# No-op unless fully configured. This is what makes it safe to deploy before the
# namespace has the Langfuse credentials.
if !endpoint.empty? && !public_key.empty? && !secret_key.empty?
  # strict_encode64, not encode64: the latter inserts newlines every 60 chars,
  # and a newline inside an HTTP header value makes every export fail with 400.
  auth = Base64.strict_encode64("#{public_key}:#{secret_key}")

  OpenTelemetry::SDK.configure do |c|
    c.service_name = ENV.fetch('OTEL_SERVICE_NAME', '${{ values.repoName }}')
    c.add_span_processor(
      OpenTelemetry::SDK::Trace::Export::BatchSpanProcessor.new(
        OpenTelemetry::Exporter::OTLP::Exporter.new(
          # The complete URL, verbatim. The exporter does NOT append /v1/traces
          # to this option — but OTEL_EXPORTER_OTLP_ENDPOINT would be treated as
          # a base and would, yielding .../otel/v1/traces/v1/traces and a 404.
          endpoint: endpoint,
          headers: { 'Authorization' => "Basic #{auth}" }
        )
      )
    )
  end

  at_exit { OpenTelemetry.tracer_provider.shutdown }
end
```

The `at_exit` flush is not optional — the batch processor holds spans for up to its scheduled
delay, so without it the last few calls before a pod termination are lost.

Sampling is configured through the standard env vars: set `OTEL_TRACES_SAMPLER` to
`parentbased_traceidratio` and `OTEL_TRACES_SAMPLER_ARG` to your `LANGFUSE_SAMPLE_RATE` value.
Parent-based matters — dropping a child of a sampled parent leaves a hole in the waterfall.

## 3. Wrap each model call

```ruby
TRACER = OpenTelemetry.tracer_provider.tracer('${{ values.repoName }}')

def chat(prompt, model:)
  TRACER.in_span('chat', kind: :client) do |span|
    span.set_attribute('langfuse.observation.type', 'generation')
    span.set_attribute('langfuse.trace.name', "#{service_name}.chat")
    # The tag the Backstage Langfuse tab filters on.
    span.set_attribute('langfuse.trace.tags', service_name)
    span.set_attribute('gen_ai.request.model', model)

    if ENV['LANGFUSE_CAPTURE_IO'] == 'true'
      span.set_attribute('langfuse.observation.input', prompt[0, 8_000])
    end

    response = call_the_model(prompt, model: model)

    # Langfuse computes cost from these plus the model id. Without them the
    # span shows latency but no cost.
    span.set_attribute('gen_ai.usage.input_tokens', response.input_tokens)
    span.set_attribute('gen_ai.usage.output_tokens', response.output_tokens)
    if ENV['LANGFUSE_CAPTURE_IO'] == 'true'
      span.set_attribute('langfuse.observation.output', response.text[0, 8_000])
    end

    response
  end
end
```

`in_span` records the exception and sets the error status automatically when the block raises, so
failed calls do not show as successes.

Keep the input/output capture gated on `LANGFUSE_CAPTURE_IO` and truncated at 8,000 characters —
anyone with Langfuse access can read whatever you record.

## Verify

See `langfuse/README.md` in this directory for the namespace label, the Helm values patch and the
catalog annotation.
