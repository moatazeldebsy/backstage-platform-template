import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { z } from 'zod';

const PORT = parseInt(process.env.PORT ?? '${{ values.port }}', 10);
{% if values.enableAuth %}
const API_KEY = process.env.MCP_API_KEY ?? '';
{% endif %}

const server = new McpServer({
  name: '${{ values.name }}',
  version: '1.0.0',
});

// ── Tools ─────────────────────────────────────────────────────────────────────
// Add your tools here. Each tool is a function Claude can call.

server.tool(
  'hello',
  'A sample tool — replace with your real tools',
  { message: z.string().describe('Message to echo back') },
  async ({ message }) => ({
    content: [{ type: 'text' as const, text: `${{ values.name }} says: ${message}` }],
  }),
);

// ── HTTP server ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

{% if values.enableAuth %}
app.use((req, res, next) => {
  const key = req.headers['x-api-key'] ?? req.query['api_key'];
  if (key !== API_KEY) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
});
{% endif %}

app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
app.get('/ready',   (_req, res) => res.json({ status: 'ready' }));

app.all('/mcp', async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(PORT, () => {
  console.log(`${{ values.name }} MCP server listening on :${PORT}/mcp`);
});
