/**
 * Langfuse / OpenTelemetry tracing for LLM calls.
 *
 * Scaffolded by the IDP `enable-langfuse-tracing` template. Adapted from
 * `services/*-mcp-server/src/telemetry.ts` in the platform repo, but it is
 * deliberately NOT the same file: that one is byte-identical across the eight
 * MCP servers and CI checksums the copies, whereas this one is yours to edit.
 * Do not add it to that checksum job.
 *
 * Install:
 *   npm install @opentelemetry/api @opentelemetry/core \
 *     @opentelemetry/exporter-trace-otlp-proto @opentelemetry/resources \
 *     @opentelemetry/sdk-trace-node @opentelemetry/semantic-conventions
 *
 * Use:
 *   import { initTracing, withGeneration, shutdownTracing } from './langfuse/telemetry';
 *
 *   initTracing('${{ values.repoName }}');                 // once, at startup
 *   process.on('SIGTERM', () => void shutdownTracing());   // flush on shutdown
 *
 *   const reply = await withGeneration(
 *     'chat',
 *     { model, input: userMessage },
 *     async () => callTheModel(userMessage),
 *   );
 *
 * Design notes
 * ------------
 * - Raw OpenTelemetry, not the Langfuse SDK. The SDK peer-depends on the same
 *   OTEL packages and its only real addition is a span processor that sets a
 *   static auth header — three lines here. Plain OTEL also guarantees the same
 *   span envelope as KAgent, so agent→service traces nest correctly.
 *
 * - No auto-instrumentation. @opentelemetry/auto-instrumentations-node needs an
 *   ESM `--import` preload, which means editing your Dockerfile CMD and breaks
 *   watch-mode dev servers. Manual spans only.
 *
 * - Disabled by default. With LANGFUSE_OTLP_ENDPOINT unset every export here
 *   returns immediately: no provider, no exporter, zero overhead. That is what
 *   makes it safe to merge this before the namespace has the credentials.
 */

import {
  SpanKind,
  SpanStatusCode,
  trace,
  type Span,
} from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
// The *-proto exporter, not *-http: the latter serialises OTLP as JSON, while
// Langfuse's ingest and KAgent's exporter both speak OTLP/HTTP protobuf.
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

// NOTE: read once at module load. Changing these needs a pod restart, which is
// what `kubectl rollout restart` after the key distribution does anyway.
const ENDPOINT = process.env.LANGFUSE_OTLP_ENDPOINT ?? '';
const PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY ?? '';
const SECRET_KEY = process.env.LANGFUSE_SECRET_KEY ?? '';
const CAPTURE_IO = (process.env.LANGFUSE_CAPTURE_IO ?? 'false').toLowerCase() === 'true';
const SAMPLE_RATE = Number.parseFloat(process.env.LANGFUSE_SAMPLE_RATE ?? '1.0');

/** Hard cap on any single captured input/output attribute. */
const MAX_IO_CHARS = 8_000;

let provider: NodeTracerProvider | undefined;
let enabled = false;
let serviceTag = '${{ values.repoName }}';

/** True when tracing is configured AND usable. */
export function tracingEnabled(): boolean {
  return enabled;
}

/**
 * Set up the tracer provider. Safe to call more than once; only the first call
 * does anything. Never throws — a misconfigured tracing backend must not stop
 * the service from serving traffic.
 *
 * `testProcessor` is a seam for tests that need to read spans back without
 * standing up an OTLP collector. Production callers pass one argument.
 */
export function initTracing(serviceName: string, testProcessor?: SpanProcessor): void {
  serviceTag = process.env.OTEL_SERVICE_NAME ?? serviceName;
  if (provider || !ENDPOINT) return;

  if (!PUBLIC_KEY || !SECRET_KEY) {
    console.warn(
      '[telemetry] LANGFUSE_OTLP_ENDPOINT is set but LANGFUSE_PUBLIC_KEY/' +
        'LANGFUSE_SECRET_KEY are missing — tracing stays disabled.',
    );
    return;
  }

  try {
    // Langfuse authenticates OTLP ingest with HTTP Basic over the project key
    // pair. Set explicitly rather than via OTEL_EXPORTER_OTLP_HEADERS so the two
    // can never disagree.
    const auth = Buffer.from(`${PUBLIC_KEY}:${SECRET_KEY}`).toString('base64');

    const exporter = new OTLPTraceExporter({
      // An explicit full URL, deliberately NOT OTEL_EXPORTER_OTLP_ENDPOINT:
      // that variable is a *base* onto which the exporter appends /v1/traces,
      // while Langfuse documents a complete path. Mixing the two yields
      // .../api/public/otel/v1/traces/v1/traces and a silent 404.
      url: ENDPOINT,
      headers: { Authorization: `Basic ${auth}` },
    });

    provider = new NodeTracerProvider({
      resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceTag }),
      sampler: new ParentBasedSampler({
        // Parent-based so a sampled upstream trace keeps its child spans:
        // dropping a child of a sampled parent leaves a hole in the waterfall.
        root: new TraceIdRatioBasedSampler(
          Number.isFinite(SAMPLE_RATE) ? SAMPLE_RATE : 1.0,
        ),
      }),
      spanProcessors: testProcessor ? [testProcessor] : [new BatchSpanProcessor(exporter)],
    });

    provider.register({ propagator: new W3CTraceContextPropagator() });
    enabled = true;
    console.log(`[telemetry] Langfuse tracing enabled → ${ENDPOINT}`);
  } catch (err) {
    console.warn('[telemetry] failed to initialise tracing — continuing without it:', err);
    provider = undefined;
    enabled = false;
  }
}

/**
 * Flush buffered spans on shutdown. The batch processor holds spans for up to
 * its scheduled delay, so without this the last few calls before a pod
 * termination are lost. Bounded so a hung exporter cannot block SIGTERM.
 */
export async function shutdownTracing(timeoutMs = 2_000): Promise<void> {
  if (!provider) return;
  try {
    await Promise.race([
      provider.shutdown(),
      new Promise<void>(resolve => setTimeout(resolve, timeoutMs)),
    ]);
  } catch {
    /* shutting down anyway */
  }
}

function clip(value: unknown): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined || text === null) return '';
  return text.length > MAX_IO_CHARS ? `${text.slice(0, MAX_IO_CHARS)}…[truncated]` : text;
}

/** What Langfuse needs to render a model call as a generation. */
export interface GenerationOptions {
  /** Model id, e.g. the value you passed to the provider SDK. */
  model?: string;
  /** Prompt or messages. Only recorded when LANGFUSE_CAPTURE_IO=true. */
  input?: unknown;
  /** End-user identifier, if you have one. Drives Langfuse's per-user views. */
  userId?: string;
  /** Conversation identifier, if you have one. Groups traces into a session. */
  sessionId?: string;
  /** Extra span attributes. Keys are sent verbatim. */
  attributes?: Record<string, string | number | boolean>;
}

/**
 * Wrap one model call in a Langfuse `generation` observation.
 *
 * The langfuse.* attribute keys are what Langfuse's OTEL ingest maps onto its
 * own trace/observation model — renaming them makes the span arrive as an
 * untyped span with no cost or token accounting.
 *
 * Returns exactly what `fn` returns, and re-throws whatever it throws, so it can
 * be dropped around an existing call without changing control flow.
 */
export async function withGeneration<T>(
  name: string,
  options: GenerationOptions,
  fn: () => Promise<T>,
): Promise<T> {
  if (!enabled) return fn();

  const tracer = trace.getTracer(serviceTag);
  return tracer.startActiveSpan(name, { kind: SpanKind.CLIENT }, async (span: Span) => {
    span.setAttributes({
      'langfuse.observation.type': 'generation',
      'langfuse.trace.name': `${serviceTag}.${name}`,
      // The tag the Backstage Langfuse tab filters on. Keep it equal to the
      // `langfuse.com/service-name` annotation in catalog-info.yaml.
      'langfuse.trace.tags': serviceTag,
      ...(options.model ? { 'gen_ai.request.model': options.model } : {}),
      ...(options.userId ? { 'langfuse.user.id': options.userId } : {}),
      ...(options.sessionId ? { 'langfuse.session.id': options.sessionId } : {}),
      ...(options.attributes ?? {}),
    });
    if (CAPTURE_IO && options.input !== undefined) {
      span.setAttribute('langfuse.observation.input', clip(options.input));
    }

    try {
      const result = await fn();
      if (CAPTURE_IO) {
        span.setAttribute('langfuse.observation.output', clip(result));
      }
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Report token usage after a call. Langfuse computes cost from these plus the
 * model id, so a generation span without them shows latency but no cost.
 * Call inside the `withGeneration` callback, once the provider response is in
 * hand.
 */
export function recordUsage(inputTokens: number, outputTokens: number): void {
  if (!enabled) return;
  const span = trace.getActiveSpan();
  if (!span) return;
  span.setAttributes({
    'gen_ai.usage.input_tokens': inputTokens,
    'gen_ai.usage.output_tokens': outputTokens,
  });
}
