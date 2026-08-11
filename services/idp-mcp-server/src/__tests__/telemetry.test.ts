/**
 * Tests for the Langfuse/OTEL tool-span instrumentation.
 *
 * The most important test here is the first one: Langfuse is opt-in, so the
 * disabled path must be provably free — no patching, no provider, no cost.
 */

import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { SpanStatusCode } from '@opentelemetry/api';

const ENDPOINT = 'http://langfuse.test/api/public/otel/v1/traces';

/**
 * Fresh module registry so telemetry.ts re-reads process.env.
 *
 * jest.resetModules() alone is not enough: @opentelemetry/api stores the global
 * tracer provider on globalThis (under a version symbol), so it survives the
 * registry reset and the FIRST provider.register() of the run wins — every
 * later test would then emit into the first test's exporter and see none of
 * its own spans. trace.disable() clears that global.
 */
async function loadTelemetry(env: Record<string, string | undefined>) {
  const api = await import('@opentelemetry/api');
  api.trace.disable();
  api.propagation.disable();
  api.context.disable();

  jest.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return import('../telemetry.js');
}

/** Minimal stand-in for McpServer — instrumentTools only needs `.tool`. */
function fakeServer() {
  const registered = new Map<string, (...a: unknown[]) => Promise<unknown>>();
  const server = {
    tool(name: string, ..._rest: unknown[]) {
      const cb = arguments[arguments.length - 1] as (...a: unknown[]) => Promise<unknown>;
      registered.set(name, cb);
    },
  };
  return { server, registered };
}

const CLEAN_ENV = {
  LANGFUSE_OTLP_ENDPOINT: undefined,
  LANGFUSE_PUBLIC_KEY: undefined,
  LANGFUSE_SECRET_KEY: undefined,
  LANGFUSE_CAPTURE_IO: undefined,
  LANGFUSE_SAMPLE_RATE: undefined,
};

const ENABLED_ENV = {
  ...CLEAN_ENV,
  LANGFUSE_OTLP_ENDPOINT: ENDPOINT,
  LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
  LANGFUSE_SECRET_KEY: 'sk-lf-test',
};

describe('telemetry — disabled by default', () => {
  it('does not patch server.tool when LANGFUSE_OTLP_ENDPOINT is unset', async () => {
    const t = await loadTelemetry(CLEAN_ENV);
    t.initTracing('idp-mcp-server');
    expect(t.tracingEnabled()).toBe(false);

    const { server } = fakeServer();
    const before = server.tool;
    t.instrumentTools(server, { serverName: 'idp-mcp-server', agentId: 'a', userRef: '' });
    // Referential equality is the whole point: an unpatched method means the
    // tool call path is byte-for-byte what it was before Langfuse existed.
    expect(server.tool).toBe(before);
  });

  it('stays disabled when the endpoint is set but keys are missing', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const t = await loadTelemetry({ ...CLEAN_ENV, LANGFUSE_OTLP_ENDPOINT: ENDPOINT });
    t.initTracing('idp-mcp-server');
    expect(t.tracingEnabled()).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('telemetry — span emission', () => {
  let exporter: InMemorySpanExporter;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let t: any;

  beforeEach(async () => {
    exporter = new InMemorySpanExporter();
    t = await loadTelemetry({ ...ENABLED_ENV, LANGFUSE_CAPTURE_IO: 'true' });
    t.initTracing('idp-mcp-server', new SimpleSpanProcessor(exporter));
    expect(t.tracingEnabled()).toBe(true);
  });

  afterEach(async () => {
    await t.shutdownTracing(100);
  });

  it('emits one span per tool call, with identity attributes', async () => {
    const { server, registered } = fakeServer();
    t.instrumentTools(server, {
      serverName: 'idp-mcp-server',
      agentId: 'idp-assistant',
      userRef: 'user:default/moataz',
    });
    server.tool('catalog_search', {}, async () => ({ content: [{ type: 'text', text: 'ok' }] }));

    await registered.get('catalog_search')!({ query: 'hello' }, {});

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('catalog_search');
    expect(spans[0].attributes['mcp.tool']).toBe('catalog_search');
    expect(spans[0].attributes['mcp.agent_id']).toBe('idp-assistant');
    expect(spans[0].attributes['langfuse.session.id']).toBe('idp-assistant');
    expect(spans[0].attributes['langfuse.user.id']).toBe('user:default/moataz');
    expect(spans[0].attributes['langfuse.observation.type']).toBe('tool');
    expect(spans[0].status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it('marks the span as errored when the tool resolves with isError', async () => {
    // The MCP SDK converts a thrown handler error into a RESOLVED
    // { isError: true } rather than a rejection. A naive try/catch wrapper
    // records those as successes, which is the bug this asserts against.
    const { server, registered } = fakeServer();
    t.instrumentTools(server, { serverName: 'idp-mcp-server', agentId: 'a', userRef: '' });
    server.tool('get_service_metrics', {}, async () => ({
      isError: true,
      content: [{ type: 'text', text: 'Prometheus returned HTTP 503' }],
    }));

    await registered.get('get_service_metrics')!({ service_name: 'x' }, {});

    const [span] = exporter.getFinishedSpans();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('records an exception and rethrows when the handler throws', async () => {
    const { server, registered } = fakeServer();
    t.instrumentTools(server, { serverName: 'idp-mcp-server', agentId: 'a', userRef: '' });
    server.tool('scaffold_service', {}, async () => {
      throw new Error('boom');
    });

    await expect(registered.get('scaffold_service')!({}, {})).rejects.toThrow('boom');

    const [span] = exporter.getFinishedSpans();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.events.some(e => e.name === 'exception')).toBe(true);
  });

  it('omits the user attribute when no Backstage user is bound', async () => {
    const { server, registered } = fakeServer();
    t.instrumentTools(server, { serverName: 'idp-mcp-server', agentId: 'a', userRef: '' });
    server.tool('list_templates', {}, async () => ({ content: [] }));

    await registered.get('list_templates')!({});

    const [span] = exporter.getFinishedSpans();
    expect(span.attributes['langfuse.user.id']).toBeUndefined();
  });
});

describe('telemetry — input/output capture', () => {
  it('captures nothing when LANGFUSE_CAPTURE_IO is off (the default)', async () => {
    const exporter = new InMemorySpanExporter();
    const t = await loadTelemetry(ENABLED_ENV);
    t.initTracing('idp-mcp-server', new SimpleSpanProcessor(exporter));

    const { server, registered } = fakeServer();
    t.instrumentTools(server, { serverName: 'idp-mcp-server', agentId: 'a', userRef: '' });
    server.tool('get_user_memory', {}, async () => ({ content: [{ type: 'text', text: 'secret' }] }));

    await registered.get('get_user_memory')!({ token: 'sensitive' }, {});

    const [span] = exporter.getFinishedSpans();
    // Off by default on purpose: tool arguments and results can carry PII and
    // credentials, and Langfuse is a separate store from the [AUDIT] log.
    expect(span.attributes['langfuse.observation.input']).toBeUndefined();
    expect(span.attributes['langfuse.observation.output']).toBeUndefined();
    await t.shutdownTracing(100);
  });

  it('truncates oversized payloads when capture is on', async () => {
    const exporter = new InMemorySpanExporter();
    const t = await loadTelemetry({ ...ENABLED_ENV, LANGFUSE_CAPTURE_IO: 'true' });
    t.initTracing('idp-mcp-server', new SimpleSpanProcessor(exporter));

    const { server, registered } = fakeServer();
    t.instrumentTools(server, { serverName: 'idp-mcp-server', agentId: 'a', userRef: '' });
    server.tool('get_app_diff', {}, async () => ({ content: [] }));

    await registered.get('get_app_diff')!({ diff: 'x'.repeat(50_000) }, {});

    const [span] = exporter.getFinishedSpans();
    const input = span.attributes['langfuse.observation.input'] as string;
    expect(input.length).toBeLessThan(9_000);
    expect(input.endsWith('…[truncated]')).toBe(true);
    await t.shutdownTracing(100);
  });
});

describe('telemetry — trace context propagation', () => {
  // InMemoryTransport never populates extra.requestInfo, so extractParent is
  // exercised directly with synthetic carriers.
  const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
  const SPAN_ID = '00f067aa0ba902b7';
  const TRACEPARENT = `00-${TRACE_ID}-${SPAN_ID}-01`;

  async function parentFrom(extra: unknown) {
    const t = await loadTelemetry(ENABLED_ENV);
    // initTracing is what registers the W3CTraceContextPropagator; without it
    // propagation.extract() is a no-op and every carrier would look absent.
    // Production always initialises before serving, so mirror that here.
    t.initTracing('idp-mcp-server', new SimpleSpanProcessor(new InMemorySpanExporter()));
    const { trace: apiTrace } = await import('@opentelemetry/api');
    const ctx = t.extractParent(extra);
    return apiTrace.getSpanContext(ctx);
  }

  it('extracts traceparent from request headers (the KAgent httpx path)', async () => {
    const sc = await parentFrom({ requestInfo: { headers: { traceparent: TRACEPARENT } } });
    expect(sc?.traceId).toBe(TRACE_ID);
    expect(sc?.spanId).toBe(SPAN_ID);
  });

  it('falls back to MCP _meta when no header is present', async () => {
    const sc = await parentFrom({ _meta: { traceparent: TRACEPARENT } });
    expect(sc?.traceId).toBe(TRACE_ID);
  });

  it('yields a root context when no carrier is present', async () => {
    // Spans then become siblings of the agent trace rather than children —
    // correlated by langfuse.session.id instead of by parentage.
    expect(await parentFrom({})).toBeUndefined();
    expect(await parentFrom(undefined)).toBeUndefined();
  });
});

describe('telemetry — shutdown timer cleanup', () => {
  // shutdownTracing races provider.shutdown() against a timeout. The timer is
  // the loser on the normal path, and leaving it armed kept the event loop
  // alive for the rest of timeoutMs — delaying SIGTERM in a pod and leaving a
  // handle that stops Jest workers exiting cleanly. A large timeoutMs makes the
  // regression unmistakable: without the fix this test would hold a 30s handle.
  it('clears the race timer when shutdown wins', async () => {
    const t = await loadTelemetry(ENABLED_ENV);
    t.initTracing('idp-mcp-server', new SimpleSpanProcessor(new InMemorySpanExporter()));
    expect(t.tracingEnabled()).toBe(true);

    const clearSpy = jest.spyOn(global, 'clearTimeout');
    const started = Date.now();
    await t.shutdownTracing(30_000);

    expect(clearSpy).toHaveBeenCalled();
    // Returns as soon as shutdown() resolves rather than waiting out the timer.
    expect(Date.now() - started).toBeLessThan(5_000);
    clearSpy.mockRestore();
  });

  it('is a no-op when tracing was never initialised', async () => {
    const t = await loadTelemetry(CLEAN_ENV);
    await expect(t.shutdownTracing(30_000)).resolves.toBeUndefined();
  });
});
