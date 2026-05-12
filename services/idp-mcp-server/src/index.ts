import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import fetch from 'node-fetch';
import { register, collectDefaultMetrics, Counter, Histogram } from 'prom-client';
import fs from 'fs';

const BACKSTAGE_URL = process.env.BACKSTAGE_URL ?? 'http://backstage:7007';
// External URL used in user-facing links (browser-accessible, not internal cluster DNS)
const BACKSTAGE_EXTERNAL_URL = process.env.BACKSTAGE_EXTERNAL_URL ?? 'http://backstage.idp.local';
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
  // Use explicit K8S_TOKEN env var first; fall back to in-cluster service account token.
  const SA_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';
  const token = K8S_TOKEN || (fs.existsSync(SA_TOKEN_PATH) ? fs.readFileSync(SA_TOKEN_PATH, 'utf8').trim() : '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${K8S_API}${path}`, { headers, ...(process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' ? {} : {}) });
  if (!res.ok) throw new Error(`K8s API error ${res.status}`);
  return res.json() as Promise<{ items: Array<Record<string, unknown>> }>;
}

// ── MCP Server factory ────────────────────────────────────────────────────
// Stateless Streamable HTTP requires a fresh McpServer per request because
// McpServer.connect() can only be called once per instance.
function createServer() {
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
      // Backstage catalog API: all filters go through filter=key=value pairs (comma-separated for AND).
      // The `kind` param is NOT a top-level query param — it must be filter=kind=Component.
      const kindParam = kind ? `filter=kind=${kind}&` : '';
      const data = await fetchCatalog(`/api/catalog/entities?${kindParam}filter=metadata.name=${encodeURIComponent(query)}`) as unknown[];
      if (!Array.isArray(data) || data.length === 0) {
        // fallback: full list search (client-side fuzzy match)
        const all = await fetchCatalog(`/api/catalog/entities?${kindParam}limit=200`) as Array<{ metadata: { name: string; description?: string }; kind: string; spec?: { owner?: string; type?: string } }>;
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
  'Trigger a Backstage scaffolder template to create a new service. ' +
  'IMPORTANT: values must include "repoUrl" in Backstage RepoUrlPicker format: ' +
  '"github.com?owner=OWNER&repo=REPO_NAME" (e.g. "github.com?owner=moatazeldebsy&repo=my-service"). ' +
  'Required values: name (string), description (string), owner (Backstage group ref, e.g. "group:default/platform-team"), ' +
  'repoUrl (RepoUrlPicker format as above).',
  {
    template_ref: z.string().describe('Template entity ref, e.g. template:default/nodejs-service'),
    values: z.record(z.string(), z.unknown()).describe(
      'Template parameter values. Required: name, description, owner (e.g. "group:default/platform-team"), ' +
      'repoUrl (format: "github.com?owner=OWNER&repo=REPO_NAME"). ' +
      'repoUrl is auto-constructed from name+owner if omitted.'
    ),
  },
  async ({ template_ref, values }) => {
    const end = toolDuration.startTimer({ tool: 'scaffold_service' });
    toolCalls.inc({ tool: 'scaffold_service' });
    try {
      // Ensure repoUrl is in Backstage RepoUrlPicker format: github.com?owner=X&repo=Y
      // The AI may omit it entirely, or pass a full https://github.com/... URL — normalise both.
      const enrichedValues: Record<string, unknown> = { ...values };
      const repoName = (enrichedValues['name'] as string | undefined) ?? '';
      // owner may be a Backstage group ref like "group:default/platform-team" — extract the last segment
      const rawOwner = (enrichedValues['owner'] as string | undefined) ?? '';
      const ghOwner = rawOwner.includes('/') ? rawOwner.split('/').pop()! : (rawOwner || 'moatazeldebsy');

      if (!enrichedValues['repoUrl']) {
        // Auto-build from name + owner
        enrichedValues['repoUrl'] = `github.com?owner=${encodeURIComponent(ghOwner)}&repo=${encodeURIComponent(repoName)}`;
      } else if (
        typeof enrichedValues['repoUrl'] === 'string' &&
        enrichedValues['repoUrl'].startsWith('https://github.com/')
      ) {
        // Normalize full HTTPS URL to RepoUrlPicker format
        const parts = enrichedValues['repoUrl'].replace('https://github.com/', '').split('/');
        const urlOwner = parts[0] ?? ghOwner;
        const urlRepo = parts[1] ?? repoName;
        enrichedValues['repoUrl'] = `github.com?owner=${encodeURIComponent(urlOwner)}&repo=${encodeURIComponent(urlRepo)}`;
      }

      const authHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      if (BACKSTAGE_TOKEN) authHeaders['Authorization'] = `Bearer ${BACKSTAGE_TOKEN}`;
      const res = await fetch(`${BACKSTAGE_URL}/api/scaffolder/v2/tasks`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ templateRef: template_ref, values: enrichedValues }),
      });
      if (!res.ok) throw new Error(`Scaffolder error ${res.status}: ${await res.text()}`);
      const task = await res.json() as { id: string };

      // Poll for task completion so callers don't need to make authenticated status requests.
      const pollHeaders: Record<string, string> = {};
      if (BACKSTAGE_TOKEN) pollHeaders['Authorization'] = `Bearer ${BACKSTAGE_TOKEN}`;
      const POLL_INTERVAL_MS = 4000;
      const POLL_TIMEOUT_MS = 180000; // 3 minutes
      const deadline = Date.now() + POLL_TIMEOUT_MS;
      let taskStatus: string = 'processing';
      let taskOutput: unknown = undefined;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
        const statusRes = await fetch(`${BACKSTAGE_URL}/api/scaffolder/v2/tasks/${task.id}`, { headers: pollHeaders });
        if (statusRes.ok) {
          const statusBody = await statusRes.json() as { status: string; output?: unknown };
          taskStatus = statusBody.status;
          taskOutput = statusBody.output;
          if (taskStatus === 'completed' || taskStatus === 'failed' || taskStatus === 'cancelled') break;
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            task_id: task.id,
            status: taskStatus,
            output: taskOutput,
            ui_url: `${BACKSTAGE_EXTERNAL_URL}/create/tasks/${task.id}`,
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

server.tool(
  'list_templates',
  'List all available Backstage scaffolder templates with name, title, description, and template ref. ' +
  'Use this to discover what can be scaffolded before calling scaffold_service.',
  {},
  async () => {
    const end = toolDuration.startTimer({ tool: 'list_templates' });
    toolCalls.inc({ tool: 'list_templates' });
    try {
      const data = await fetchCatalog('/api/catalog/entities?filter=kind=Template&limit=100') as Array<{
        metadata: { name: string; description?: string; title?: string };
        spec?: { type?: string };
      }>;
      const templates = data.map(e => ({
        name: e.metadata.name,
        title: e.metadata.title ?? e.metadata.name,
        description: e.metadata.description,
        templateRef: `template:default/${e.metadata.name}`,
        type: e.spec?.type,
      }));
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(templates, null, 2) }],
      };
    } finally {
      end();
    }
  }
);

  return server;
}

// ── Express HTTP server with Streamable HTTP transport ──────────────────────

app.get('/healthz', (_req, res) => res.json({ status: 'ok', version: '1.0.0' }));
app.get('/ready', (_req, res) => res.json({ status: 'ready' }));
app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// Stateless Streamable HTTP — each request gets a fresh McpServer+transport.
// This is required because McpServer.connect() can only be called once per instance.
app.post('/mcp', express.json(), async (req, res) => {
  const srv = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await srv.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(PORT, () => {
  console.log(`IDP MCP Server listening on :${PORT}`);
  console.log(`  MCP endpoint: http://localhost:${PORT}/mcp`);
  console.log(`  Health:       http://localhost:${PORT}/healthz`);
});
