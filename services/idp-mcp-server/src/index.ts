import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { register, collectDefaultMetrics, Counter } from 'prom-client';
import { createServer } from './server.js';

collectDefaultMetrics();

// Not exported to server.ts — only the Express layer tracks AI model usage.
new Counter({ name: 'ai_api_calls_total', help: 'Total AI API calls by model', labelNames: ['server', 'model', 'tool'] });

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

app.listen(PORT, () => {
  console.log(`IDP MCP Server listening on :${PORT}`);
  console.log(`  MCP endpoint: http://localhost:${PORT}/mcp`);
  console.log(`  Health:       http://localhost:${PORT}/healthz`);
});
