import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { register, collectDefaultMetrics } from 'prom-client';
import { createServer } from './server.js';
import { initTracing, shutdownTracing } from './telemetry.js';

const PORT = parseInt(process.env.PORT ?? '3002', 10);

collectDefaultMetrics();

const app = express();

// No-op unless LANGFUSE_OTLP_ENDPOINT is set, which bootstrap-ai.sh --langfuse
// supplies through an optional ConfigMap/Secret pair.
initTracing('qa-mcp-server');

app.get('/healthz', (_req, res) => res.json({ status: 'ok', version: '1.0.0' }));
app.get('/ready', (_req, res) => res.json({ status: 'ready' }));
app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.post('/mcp', express.json(), async (req, res) => {
  // Matches the other MCP servers: without this every qa span was attributed to
  // the agent id "unknown", which makes the Langfuse session grouping useless.
  const agentId = (req.get('x-agent-id') ?? req.get('user-agent') ?? 'unknown').slice(0, 64);
  const srv = createServer(agentId);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await srv.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const server = app.listen(PORT, () => {
  console.log(`QA MCP Server listening on :${PORT}`);
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
