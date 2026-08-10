/**
 * Langfuse / OpenTelemetry tracing for MCP tool calls.
 *
 * This file is COPIED VERBATIM into every services/*-mcp-server. There is no
 * root package.json and each Dockerfile builds with its own service directory
 * as the build context, so a shared workspace package would be invisible to
 * `npm ci`. A CI job checksums all copies and fails on drift — keep this file
 * free of service-specific code so that stays true.
 *
 * Design notes
 * ------------
 * - Raw OpenTelemetry, not @langfuse/otel. The Langfuse SDK peer-depends on the
 *   same OTEL packages plus @langfuse/core, and its only real addition is a
 *   span processor that sets a static auth header (three lines here). More
 *   importantly KAgent emits *plain* OTEL, so using plain OTEL on both ends of
 *   the hop guarantees identical span envelopes and propagator behaviour.
 *
 * - No auto-instrumentation. @opentelemetry/auto-instrumentations-node needs an
 *   ESM `--import` preload, which would mean editing every Dockerfile CMD and
 *   would break `tsx --watch` in dev. Manual spans only.
 *
 * - Disabled by default. With LANGFUSE_OTLP_ENDPOINT unset, initTracing() and
 *   instrumentTools() both return immediately: no provider, no exporter, no
 *   patching, zero overhead. Langfuse is opt-in (bootstrap-ai.sh --langfuse),
 *   so "off" is the common case and must cost nothing.
 */

import {
  SpanKind,
  SpanStatusCode,
  context,
  propagation,
  trace,
  type Context,
} from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
// The *-proto exporter, not *-http: the latter serialises OTLP as JSON, while
// Langfuse's ingest and KAgent's exporter both speak OTLP/HTTP protobuf.
// Matching KAgent matters — both ends of the agent→tool hop should encode
// identically.
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

/** Identity bound at the HTTP boundary — never from LLM tool arguments. */
export interface TraceCtx {
  serverName: string;
  agentId: string;
  userRef: string;
}

// NOTE: read once at module load. Changing these needs a pod restart, which is
// what the ConfigMap/Secret rollout in bootstrap-ai.sh --langfuse does anyway.
const ENDPOINT = process.env.LANGFUSE_OTLP_ENDPOINT ?? '';
const PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY ?? '';
const SECRET_KEY = process.env.LANGFUSE_SECRET_KEY ?? '';
const CAPTURE_IO = (process.env.LANGFUSE_CAPTURE_IO ?? 'false').toLowerCase() === 'true';
const SAMPLE_RATE = Number.parseFloat(process.env.LANGFUSE_SAMPLE_RATE ?? '1.0');

/** Hard cap on any single captured input/output attribute. */
const MAX_IO_CHARS = 8_000;

let provider: NodeTracerProvider | undefined;
let enabled = false;

/** True when tracing is configured AND usable. */
export function tracingEnabled(): boolean {
  return enabled;
}

/**
 * Set up the tracer provider. Safe to call more than once; only the first call
 * does anything. Never throws — a misconfigured tracing backend must not stop
 * an MCP server from serving tools.
 *
 * `testProcessor` is a seam for the unit tests, which need to read spans back
 * without standing up an OTLP collector. Production callers pass one argument.
 */
export function initTracing(serviceName: string, testProcessor?: SpanProcessor): void {
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
    // pair. Set explicitly rather than via OTEL_EXPORTER_OTLP_HEADERS so the
    // two never disagree.
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
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? serviceName,
      }),
      sampler: new ParentBasedSampler({
        // Parent-based so a sampled agent trace keeps its tool spans: dropping
        // a child of a sampled parent leaves a hole in the waterfall.
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
 * its scheduled delay, so without this the last few tool calls before a pod
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

/**
 * Pull a W3C trace context out of the MCP request so a tool span nests under
 * the agent's LLM span rather than starting a new trace.
 *
 * KAgent's Python runtime instruments httpx (HTTPXClientInstrumentor), and its
 * MCP client speaks streamable HTTP over httpx, so `traceparent` should arrive
 * as a request header. That is not guaranteed by the MCP spec, so `_meta` is
 * checked as a fallback and no carrier simply yields a root span.
 */
export function extractParent(extra: unknown): Context {
  const active = context.active();
  if (!extra || typeof extra !== 'object') return active;

  const rec = extra as Record<string, unknown>;
  const headers =
    ((rec.requestInfo as { headers?: Record<string, unknown> } | undefined)?.headers ?? {}) as Record<
      string,
      unknown
    >;
  const meta = (rec._meta ?? {}) as Record<string, unknown>;

  const carrier: Record<string, string> = {};
  for (const key of ['traceparent', 'tracestate']) {
    // Node lowercases incoming header names, but _meta is caller-controlled.
    const value = headers[key] ?? headers[key.toUpperCase()] ?? meta[key];
    if (typeof value === 'string' && value) carrier[key] = value;
  }

  return Object.keys(carrier).length > 0 ? propagation.extract(active, carrier) : active;
}

type ToolCallback = (...args: unknown[]) => Promise<unknown>;

/**
 * Wrap every tool registered on `server` in a span.
 *
 * Patches `server.tool` (and `registerTool`) once rather than touching all 52
 * call sites across the eight MCP servers. The SDK's `tool()` has six
 * overloads and some tools register with `{}` as their schema, so a per-site
 * helper would need overload-aware typing everywhere; this only needs to know
 * that the callback is the last argument.
 */
export function instrumentTools(server: unknown, ctx: TraceCtx): void {
  if (!enabled) return;

  const target = server as Record<string, unknown>;
  const tracer = trace.getTracer(ctx.serverName);

  for (const method of ['tool', 'registerTool'] as const) {
    const original = target[method];
    if (typeof original !== 'function') continue;
    const bound = (original as (...a: unknown[]) => unknown).bind(server);

    target[method] = (...args: unknown[]) => {
      const last = args.length - 1;
      const callback = args[last];
      if (typeof callback !== 'function') return bound(...args);

      const toolName = String(args[0]);

      args[last] = async (...cbArgs: unknown[]) => {
        // The SDK passes (args, extra) when a zod shape is present and (extra)
        // when it is not, so `extra` is always the final argument.
        const extra = cbArgs[cbArgs.length - 1];
        const toolArgs = cbArgs.length > 1 ? cbArgs[0] : undefined;

        return context.with(extractParent(extra), () =>
          tracer.startActiveSpan(toolName, { kind: SpanKind.SERVER }, async span => {
            span.setAttributes({
              // langfuse.* keys are what Langfuse's OTEL ingest maps onto its
              // own trace/observation model.
              'langfuse.observation.type': 'tool',
              'langfuse.trace.name': `${ctx.serverName}.${toolName}`,
              'langfuse.session.id': ctx.agentId,
              'mcp.server': ctx.serverName,
              'mcp.tool': toolName,
              'mcp.agent_id': ctx.agentId,
              ...(ctx.userRef ? { 'langfuse.user.id': ctx.userRef } : {}),
            });
            if (CAPTURE_IO && toolArgs !== undefined) {
              span.setAttribute('langfuse.observation.input', clip(toolArgs));
            }

            try {
              const result = (await (callback as ToolCallback)(...cbArgs)) as
                | { isError?: boolean }
                | undefined;

              // The MCP SDK catches a thrown handler error and RESOLVES with
              // { isError: true } instead of rejecting — see the
              // "MCP SDK resolves (not rejects)" case in __tests__/tools.test.ts.
              // Without this branch every failed tool call records as a success.
              if (result?.isError) {
                span.setStatus({ code: SpanStatusCode.ERROR, message: 'tool returned isError' });
              }
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
          }),
        );
      };

      return bound(...args);
    };
  }
}
