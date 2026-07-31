import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { register, collectDefaultMetrics } from 'prom-client';
import { createServer } from './server.js';

const PORT = parseInt(process.env.PORT ?? '3010', 10);

if (!process.env.GITHUB_TOKEN) {
  console.warn('[security-mcp-server] WARNING: GITHUB_TOKEN not set — list_vulnerable_deps/get_secret_rotation_status will fail');
}

collectDefaultMetrics();

const app = express();

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

app.listen(PORT, () => {
  console.log(`Security MCP Server listening on :${PORT}`);
});
