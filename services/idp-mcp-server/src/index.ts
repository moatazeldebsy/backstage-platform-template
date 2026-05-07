import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import fetch from 'node-fetch';
import { register, collectDefaultMetrics, Counter, Histogram } from 'prom-client';

const BACKSTAGE_URL = process.env.BACKSTAGE_URL ?? 'http://backstage:7007';
const BACKSTAGE_TOKEN = process.env.BACKSTAGE_TOKEN ?? '';
const PROMETHEUS_URL = process.env.PROMETHEUS_URL ?? 'http://prometheus-kube-prometheus-prometheus.monitoring:9090';
const K8S_API = process.env.K8S_API ?? 'https://kubernetes.default.svc';
const K8S_TOKEN = process.env.K8S_TOKEN ?? '';
const PORT = parseInt(process.env.PORT ?? '3001', 10);

collectDefaultMetrics();
const toolCalls = new Counter({ name: 'mcp_tool_calls_total', help: 'Total MCP tool calls', labelNames: ['tool'] });
const toolDuration = new Histogram({ name: 'mcp_tool_duration_seconds', help: 'MCP tool call duration', labelNames: ['tool'] });

const app = express();

// ── Backstage catalog helpers ──────────────────────────────────────────────

async function fetchCatalog(path: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (BACKSTAGE_TOKEN) headers['Authorization'] = `Bearer ${BACKSTAGE_TOKEN}`;
  const res = await fetch(`${BACKSTAGE_URL}${path}`, { headers });
  if (!res.ok) throw new Error(`Backstage API error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function fetchPrometheus(query: string) {
  const url = `${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Prometheus error ${res.status}`);
  return res.json() as Promise<{ data: { result: Array<{ metric: Record<string, string>; value: [number, string] }> } }>;
}

async function fetchK8s(path: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (K8S_TOKEN) headers['Authorization'] = `Bearer ${K8S_TOKEN}`;
  const res = await fetch(`${K8S_API}${path}`, { headers, ...(process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' ? {} : {}) });
  if (!res.ok) throw new Error(`K8s API error ${res.status}`);
  return res.json() as Promise<{ items: Array<Record<string, unknown>> }>;
}

// ── MCP Server ────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'idp-mcp-server',
  version: '1.0.0',
});

server.tool(
  'catalog_search',
  'Search the Backstage service catalog for components, APIs, and resources',
  {
    query: z.string().describe('Search term — service name, team name, or keyword'),
    kind: z.enum(['Component', 'Resource', 'API', 'System']).optional().describe('Limit results to this entity kind'),
  },
  async ({ query, kind }) => {
    const end = toolDuration.startTimer({ tool: 'catalog_search' });
    toolCalls.inc({ tool: 'catalog_search' });
    try {
      const kindFilter = kind ? `kind=${kind}&` : '';
      const data = await fetchCatalog(`/api/catalog/entities?${kindFilter}filter=metadata.name=${query}`) as unknown[];
      if (!Array.isArray(data) || data.length === 0) {
        // fallback: full list search
        const all = await fetchCatalog(`/api/catalog/entities?${kindFilter}limit=200`) as Array<{ metadata: { name: string; description?: string }; kind: string; spec?: { owner?: string; type?: string } }>;
        const matches = all.filter(e =>
          e.metadata.name.toLowerCase().includes(query.toLowerCase()) ||
          (e.metadata.description ?? '').toLowerCase().includes(query.toLowerCase())
        );
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(matches.slice(0, 10).map(e => ({
              name: e.metadata.name,
              kind: e.kind,
              type: e.spec?.type,
              owner: e.spec?.owner,
              description: e.metadata.description,
            })), null, 2),
          }],
        };
      }
      const entities = data as Array<{ metadata: { name: string; description?: string }; kind: string; spec?: { owner?: string; type?: string } }>;
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(entities.map(e => ({
            name: e.metadata.name,
            kind: e.kind,
            type: e.spec?.type,
            owner: e.spec?.owner,
            description: e.metadata.description,
          })), null, 2),
        }],
      };
    } finally {
      end();
    }
  }
);

server.tool(
  'get_service_metrics',
  'Query Prometheus metrics for a service by name',
  {
    service_name: z.string().describe('The Kubernetes service name (e.g. hello-service)'),
    metric: z.string().optional().describe('Specific metric name (default: http_requests_total)'),
  },
  async ({ service_name, metric = 'http_requests_total' }) => {
    const end = toolDuration.startTimer({ tool: 'get_service_metrics' });
    toolCalls.inc({ tool: 'get_service_metrics' });
    try {
      const query = `${metric}{job="${service_name}"}`;
      const data = await fetchPrometheus(query);
      const results = data.data.result.map(r => ({
        labels: r.metric,
        value: r.value[1],
        timestamp: new Date(r.value[0] * 1000).toISOString(),
      }));
      return {
        content: [{
          type: 'text' as const,
          text: results.length > 0
            ? JSON.stringify(results, null, 2)
            : `No metrics found for ${metric} on service "${service_name}". The service may not be scraping yet.`,
        }],
      };
    } finally {
      end();
    }
  }
);

server.tool(
  'scaffold_service',
  'Trigger a Backstage scaffolder template to create a new service or resource',
  {
    template_ref: z.string().describe('Template entity ref, e.g. template:default/nodejs-service'),
    values: z.record(z.string(), z.unknown()).describe('Template parameter values as key-value pairs'),
  },
  async ({ template_ref, values }) => {
    const end = toolDuration.startTimer({ tool: 'scaffold_service' });
    toolCalls.inc({ tool: 'scaffold_service' });
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (BACKSTAGE_TOKEN) headers['Authorization'] = `Bearer ${BACKSTAGE_TOKEN}`;
      const res = await fetch(`${BACKSTAGE_URL}/api/scaffolder/v2/tasks`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ templateRef: template_ref, values }),
      });
      if (!res.ok) throw new Error(`Scaffolder error ${res.status}: ${await res.text()}`);
      const task = await res.json() as { id: string };
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            task_id: task.id,
            status_url: `${BACKSTAGE_URL}/api/scaffolder/v2/tasks/${task.id}`,
            ui_url: `http://localhost:3000/create/tasks/${task.id}`,
          }, null, 2),
        }],
      };
    } finally {
      end();
    }
  }
);

server.tool(
  'list_deployments',
  'List Kubernetes Deployments and their readiness status',
  {
    namespace: z.string().optional().describe('Kubernetes namespace (default: services)'),
  },
  async ({ namespace = 'services' }) => {
    const end = toolDuration.startTimer({ tool: 'list_deployments' });
    toolCalls.inc({ tool: 'list_deployments' });
    try {
      const data = await fetchK8s(`/apis/apps/v1/namespaces/${namespace}/deployments`);
      const deployments = data.items.map((d: Record<string, unknown>) => {
        const meta = d['metadata'] as Record<string, unknown>;
        const spec = d['spec'] as Record<string, unknown>;
        const status = d['status'] as Record<string, unknown>;
        const containers = (spec['template'] as Record<string, unknown>)?.['spec'] as Record<string, unknown>;
        const firstContainer = (containers?.['containers'] as Array<Record<string, unknown>>)?.[0];
        return {
          name: meta['name'],
          namespace: meta['namespace'],
          replicas: spec['replicas'],
          ready_replicas: status['readyReplicas'] ?? 0,
          image: firstContainer?.['image'] ?? 'unknown',
        };
      });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(deployments, null, 2),
        }],
      };
    } finally {
      end();
    }
  }
);

// ── Express HTTP server with SSE transport ────────────────────────────────

const transports: Record<string, SSEServerTransport> = {};

app.get('/healthz', (_req, res) => res.json({ status: 'ok', version: '1.0.0' }));
app.get('/ready', (_req, res) => res.json({ status: 'ready' }));
app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.get('/sse', async (req, res) => {
  const transport = new SSEServerTransport('/messages', res);
  transports[transport.sessionId] = transport;
  res.on('close', () => delete transports[transport.sessionId]);
  await server.connect(transport);
});

app.post('/messages', async (req, res) => {
  const sessionId = req.query['sessionId'] as string;
  const transport = transports[sessionId];
  if (!transport) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  await transport.handlePostMessage(req, res);
});

app.listen(PORT, () => {
  console.log(`IDP MCP Server listening on :${PORT}`);
  console.log(`  SSE endpoint: http://localhost:${PORT}/sse`);
  console.log(`  Health:       http://localhost:${PORT}/healthz`);
});
