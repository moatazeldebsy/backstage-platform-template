import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { register, collectDefaultMetrics } from 'prom-client';
import { createServer } from './server.js';
import { initTracing, shutdownTracing } from './telemetry.js';

const PORT = parseInt(process.env.PORT ?? '3006', 10);

if (!process.env.ARGOCD_TOKEN) {
  console.warn('[argocd-mcp-server] WARNING: ARGOCD_TOKEN not set — all tool calls will return 401');
}

collectDefaultMetrics();

const app = express();

// No-op unless LANGFUSE_OTLP_ENDPOINT is set, which bootstrap-ai.sh --langfuse
// supplies through an optional ConfigMap/Secret pair.
initTracing('argocd-mcp-server');

app.get('/healthz', (_req, res) => res.json({ status: 'ok', version: '0.1.0' }));
app.get('/ready', (_req, res) => res.json({ status: 'ready' }));
app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.post('/mcp', express.json(), async (req, res) => {
  const agentId = (req.get('x-agent-id') ?? req.get('user-agent') ?? 'unknown').slice(0, 64);
  const srv = createServer(agentId);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await srv.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const server = app.listen(PORT, () => {
  console.log(`ArgoCD MCP Server listening on :${PORT}`);
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
