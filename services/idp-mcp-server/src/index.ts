import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { register, collectDefaultMetrics } from 'prom-client';
import { createServer } from './server.js';
import { initTracing, shutdownTracing } from './telemetry.js';

collectDefaultMetrics();

// Was: an `ai_api_calls_total` Counter, declared here and never incremented by
// anything — it reported 0 forever. Per-tool telemetry is now real, via
// mcp_tool_calls_total (Prometheus) and Langfuse spans (telemetry.ts).

// No-op unless LANGFUSE_OTLP_ENDPOINT is set, which bootstrap-ai.sh --langfuse
// supplies through an optional ConfigMap/Secret pair.
initTracing('idp-mcp-server');

const PORT = parseInt(process.env.PORT ?? '3001', 10);

const app = express();

app.get('/healthz', (_req, res) => res.json({ status: 'ok', version: '1.0.0' }));
app.get('/ready',   (_req, res) => res.json({ status: 'ready' }));
app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// Stateless Streamable HTTP — each request gets a fresh McpServer+transport.
// McpServer.connect() can only be called once per instance, so we must
// construct a new one per-request.
app.post('/mcp', express.json(), async (req, res) => {
  const agentId = (req.get('x-agent-id') ?? req.get('user-agent') ?? 'unknown').slice(0, 64);
  // X-Backstage-User is set by Backstage and forwarded by KAgent to MCP tool calls.
  // Bound at the HTTP boundary so the LLM cannot influence which user's memory is
  // accessed via tool arguments (prevents cross-user IDOR).
  const userRef = (req.get('x-backstage-user') ?? '').slice(0, 128);
  const srv = createServer(agentId, userRef);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await srv.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const server = app.listen(PORT, () => {
  console.log(`IDP MCP Server listening on :${PORT}`);
  console.log(`  MCP endpoint: http://localhost:${PORT}/mcp`);
  console.log(`  Health:       http://localhost:${PORT}/healthz`);
});

// Spans sit in the batch processor until its timer fires, so without a flush
// the last few tool calls before a pod eviction are lost. Bounded inside
// shutdownTracing so a hung exporter cannot stall termination.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    server.close();
    void shutdownTracing().then(() => process.exit(0));
  });
}
