import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import fetch, { RequestInit } from 'node-fetch';
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
const HTTP_TIMEOUT_MS = parseInt(process.env.HTTP_TIMEOUT_MS ?? '8000', 10);

// fetchWithTimeout wraps node-fetch with an AbortSignal so an unresponsive
// upstream (Backstage / Prometheus / K8s) can't hang a tool call forever.
async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = HTTP_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Service-account token is read once at boot; kubelet rotates the file
// in-place, so re-reading per request just adds blocking I/O on the hot path.
const SA_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';
let cachedSaToken = '';
try {
  if (fs.existsSync(SA_TOKEN_PATH)) {
    cachedSaToken = fs.readFileSync(SA_TOKEN_PATH, 'utf8').trim();
    fs.watch(SA_TOKEN_PATH, { persistent: false }, () => {
      try {
        cachedSaToken = fs.readFileSync(SA_TOKEN_PATH, 'utf8').trim();
      } catch { /* ignore — keep last good token until next rotation */ }
    });
  }
} catch { /* not running in-cluster; K8S_TOKEN env var is used instead */ }

collectDefaultMetrics();
const SERVER_NAME = 'idp-mcp-server';
const toolCalls = new Counter({ name: 'mcp_tool_calls_total', help: 'Total MCP tool calls', labelNames: ['server', 'tool', 'outcome'] });
const toolDuration = new Histogram({ name: 'mcp_tool_duration_seconds', help: 'MCP tool call duration', labelNames: ['server', 'tool'] });
const aiApiCalls = new Counter({ name: 'ai_api_calls_total', help: 'Total AI API calls by model', labelNames: ['server', 'model', 'tool'] });
const agentToolCalls = new Counter({ name: 'mcp_agent_tool_calls_total', help: 'Tool calls attributed per calling agent', labelNames: ['server', 'tool', 'agent'] });

function auditLog(event: Record<string, unknown>): void {
  console.log('[AUDIT] ' + JSON.stringify({ ts: new Date().toISOString(), server: SERVER_NAME, ...event }));
}

const app = express();

// ── Backstage catalog helpers ──────────────────────────────────────────────

async function fetchCatalog(path: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (BACKSTAGE_TOKEN) headers['Authorization'] = `Bearer ${BACKSTAGE_TOKEN}`;
  const res = await fetchWithTimeout(`${BACKSTAGE_URL}${path}`, { headers });
  if (!res.ok) throw new Error(`Backstage API error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function fetchPrometheus(query: string) {
  const url = `${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(query)}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Prometheus error ${res.status}`);
  return res.json() as Promise<{ data: { result: Array<{ metric: Record<string, string>; value: [number, string] }> } }>;
}

async function fetchK8s(path: string) {
  // Use explicit K8S_TOKEN env var first; fall back to in-cluster service account token cached at boot.
  const token = K8S_TOKEN || cachedSaToken;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetchWithTimeout(`${K8S_API}${path}`, { headers });
  if (!res.ok) throw new Error(`K8s API error ${res.status}`);
  return res.json() as Promise<{ items: Array<Record<string, unknown>> }>;
}

// ── MCP Server factory ────────────────────────────────────────────────────
// Stateless Streamable HTTP requires a fresh McpServer per request because
// McpServer.connect() can only be called once per instance.
// agentId is extracted from X-Agent-ID; userRef from X-Backstage-User.
// userRef is bound in the closure at the HTTP boundary — the LLM tool call
// arguments cannot override it, preventing cross-user IDOR on memory ops.
// NOTE: user memory isolation depends on KAgent forwarding X-Backstage-User
// from the original A2A request to outgoing MCP calls. If KAgent does not
// propagate this header, userRef will be empty and memory is keyed by agentId.
function createServer(agentId: string = 'unknown', userRef: string = '') {
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
    const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'catalog_search' });
    agentToolCalls.inc({ server: SERVER_NAME, tool: 'catalog_search', agent: agentId });
    let outcome = 'success';
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
    } catch (err) {
      outcome = 'error';
      throw err;
    } finally {
      end();
      toolCalls.inc({ server: SERVER_NAME, tool: 'catalog_search', outcome });
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
    const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'get_service_metrics' });
    agentToolCalls.inc({ server: SERVER_NAME, tool: 'get_service_metrics', agent: agentId });
    let outcome = 'success';
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
    } catch (err) {
      outcome = 'error';
      throw err;
    } finally {
      end();
      toolCalls.inc({ server: SERVER_NAME, tool: 'get_service_metrics', outcome });
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
    dry_run: z.boolean().optional().describe(
      'If true, validate inputs and return a preview of what would be created without calling the Backstage API.'
    ),
  },
  async ({ template_ref, values, dry_run }) => {
    const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'scaffold_service' });
    agentToolCalls.inc({ server: SERVER_NAME, tool: 'scaffold_service', agent: agentId });
    let outcome = 'success';
    try {
      // Ensure repoUrl is in Backstage RepoUrlPicker format: github.com?owner=X&repo=Y
      // The AI may omit it entirely, or pass a full https://github.com/... URL — normalise both.
      const enrichedValues: Record<string, unknown> = { ...values };
      const repoName = (enrichedValues['name'] as string | undefined) ?? '';
      // owner may be a Backstage group ref like "group:default/platform-team" — extract the last segment
      const rawOwner = (enrichedValues['owner'] as string | undefined) ?? '';
      const ghOwner = rawOwner.includes('/') ? rawOwner.split('/').pop()! : (rawOwner || process.env.GITHUB_ORG || 'moatazeldebsy');

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

      auditLog({
        action: 'scaffold_service_requested',
        agent: agentId,
        template: template_ref,
        service: enrichedValues['name'],
        owner: enrichedValues['owner'],
        repo: enrichedValues['repoUrl'],
        dry_run: !!dry_run,
      });

      if (dry_run) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              dry_run: true,
              message: 'Dry run — no service created. Review the parameters below, then call scaffold_service again without dry_run to proceed.',
              template: template_ref,
              values: enrichedValues,
            }, null, 2),
          }],
        };
      }

      const authHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      if (BACKSTAGE_TOKEN) authHeaders['Authorization'] = `Bearer ${BACKSTAGE_TOKEN}`;
      const res = await fetchWithTimeout(`${BACKSTAGE_URL}/api/scaffolder/v2/tasks`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ templateRef: template_ref, values: enrichedValues }),
      });
      if (!res.ok) throw new Error(`Scaffolder error ${res.status}: ${await res.text()}`);
      const task = await res.json() as { id: string };

      // Poll for task completion. Exponential backoff with jitter keeps load
      // off the scaffolder when many tasks run concurrently — a fixed 4s
      // interval × N callers produced synchronized spikes on the API.
      const pollHeaders: Record<string, string> = {};
      if (BACKSTAGE_TOKEN) pollHeaders['Authorization'] = `Bearer ${BACKSTAGE_TOKEN}`;
      const POLL_TIMEOUT_MS = 180000; // 3 minutes total
      const deadline = Date.now() + POLL_TIMEOUT_MS;
      let taskStatus: string = 'processing';
      let taskOutput: unknown = undefined;
      let attempt = 0;
      while (Date.now() < deadline) {
        const base = Math.min(4000, 500 * Math.pow(2, attempt));
        const jitter = base * (0.8 + Math.random() * 0.4); // ±20%
        await new Promise(r => setTimeout(r, jitter));
        attempt++;
        const statusRes = await fetchWithTimeout(`${BACKSTAGE_URL}/api/scaffolder/v2/tasks/${task.id}`, { headers: pollHeaders });
        if (statusRes.ok) {
          const statusBody = await statusRes.json() as { status: string; output?: unknown };
          taskStatus = statusBody.status;
          taskOutput = statusBody.output;
          if (taskStatus === 'completed' || taskStatus === 'failed' || taskStatus === 'cancelled') break;
        }
      }

      auditLog({
        action: 'scaffold_service_completed',
        agent: agentId,
        template: template_ref,
        service: enrichedValues['name'],
        task_id: task.id,
        status: taskStatus,
      });
      if (taskStatus === 'failed') outcome = 'error';

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
    } catch (err) {
      outcome = 'error';
      auditLog({ action: 'scaffold_service_error', agent: agentId, template: template_ref, error: String(err) });
      throw err;
    } finally {
      end();
      toolCalls.inc({ server: SERVER_NAME, tool: 'scaffold_service', outcome });
    }
  }
);

server.tool(
  'list_deployments',
  'List Kubernetes Deployments and their readiness status. ' +
  'Queries services-dev (ArgoCD-managed workloads) and services by default. ' +
  'Pass a specific namespace to narrow results.',
  {
    namespace: z.string().optional().describe(
      'Kubernetes namespace to query. Omit to query both services-dev and services.'
    ),
  },
  async ({ namespace }) => {
    const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'list_deployments' });
    agentToolCalls.inc({ server: SERVER_NAME, tool: 'list_deployments', agent: agentId });
    let outcome = 'success';
    try {
      // Default: query both active namespaces. ArgoCD deploys to services-dev;
      // manually deployed services land in services. Querying only one produces
      // empty results that mislead the agent into thinking nothing is running.
      const namespacesToQuery = namespace
        ? [namespace]
        : ['services-dev', 'services'];

      const allDeployments: unknown[] = [];
      for (const ns of namespacesToQuery) {
        const data = await fetchK8s(`/apis/apps/v1/namespaces/${ns}/deployments`);
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
        allDeployments.push(...deployments);
      }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(allDeployments, null, 2),
        }],
      };
    } catch (err) {
      outcome = 'error';
      throw err;
    } finally {
      end();
      toolCalls.inc({ server: SERVER_NAME, tool: 'list_deployments', outcome });
    }
  }
);

server.tool(
  'list_templates',
  'List all available Backstage scaffolder templates with name, title, description, and template ref. ' +
  'Use this to discover what can be scaffolded before calling scaffold_service.',
  {},
  async () => {
    const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'list_templates' });
    agentToolCalls.inc({ server: SERVER_NAME, tool: 'list_templates', agent: agentId });
    let outcome = 'success';
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
    } catch (err) {
      outcome = 'error';
      throw err;
    } finally {
      end();
      toolCalls.inc({ server: SERVER_NAME, tool: 'list_templates', outcome });
    }
  }
);

server.tool(
  'get_template_params',
  'Fetch the exact parameter schema for a Backstage scaffolder template. ' +
  'Call this before scaffold_service to know which fields are required and their types.',
  {
    template_ref: z.string().describe(
      'Template entity ref, e.g. template:default/nodejs-service or template:default/go-service'
    ),
  },
  async ({ template_ref }) => {
    const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'get_template_params' });
    agentToolCalls.inc({ server: SERVER_NAME, tool: 'get_template_params', agent: agentId });
    let outcome = 'success';
    try {
      // Parse template:namespace/name → /api/catalog/entities/by-name/Template/namespace/name
      const withoutPrefix = template_ref.replace(/^template:/, '');
      const slashIdx = withoutPrefix.indexOf('/');
      const namespace = slashIdx !== -1 ? withoutPrefix.slice(0, slashIdx) : 'default';
      const name = slashIdx !== -1 ? withoutPrefix.slice(slashIdx + 1) : withoutPrefix;

      const entity = await fetchCatalog(
        `/api/catalog/entities/by-name/Template/${namespace}/${name}`
      ) as {
        metadata: { name: string; title?: string; description?: string };
        spec?: {
          parameters?: Array<{
            title?: string;
            required?: string[];
            properties?: Record<string, {
              type?: string;
              title?: string;
              description?: string;
              default?: unknown;
              enum?: unknown[];
            }>;
          }>;
        };
      };

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            name: entity.metadata.name,
            title: entity.metadata.title,
            description: entity.metadata.description,
            parameters: entity.spec?.parameters ?? [],
          }, null, 2),
        }],
      };
    } catch (err) {
      outcome = 'error';
      throw err;
    } finally {
      end();
      toolCalls.inc({ server: SERVER_NAME, tool: 'get_template_params', outcome });
    }
  }
);

  // ── User Memory tools ────────────────────────────────────────────────────
  // Preferences are stored as a JSON object in a ConfigMap named
  // user-memory-<sanitized-userId> in the kagent namespace.
  // The idp-mcp-server service account needs get/create/patch on configmaps
  // in the kagent namespace (see kubernetes/kagent/idp-mcp-server-rbac.yaml).

  const MEMORY_NS = 'kagent';

  function sanitizeUserId(userId: string): string {
    return userId.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 63);
  }

  // Identity for memory ops is bound from the HTTP request (X-Backstage-User header),
  // not from LLM-controlled tool arguments, to prevent cross-user IDOR.
  // memoryKey is derived here at factory time; tools expose no userId parameter.
  const memoryKey = userRef
    ? sanitizeUserId(userRef)
    : `agent-${sanitizeUserId(agentId)}`; // fallback when header not propagated

  server.tool(
    'get_user_memory',
    'Retrieve persistent preferences for the current user (preferred language, default team, recent services). Call at session start to load personalization context.',
    {},
    async () => {
      const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'get_user_memory' });
      let outcome = 'success';
      try {
        const cmName = `user-memory-${memoryKey}`;
        const token = K8S_TOKEN || cachedSaToken;
        const headers: Record<string, string> = { Accept: 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const res = await fetchWithTimeout(
          `${K8S_API}/api/v1/namespaces/${MEMORY_NS}/configmaps/${cmName}`,
          { headers },
        );

        if (res.status === 404) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ preferences: {} }) }] };
        }
        if (!res.ok) throw new Error(`K8s configmap GET returned ${res.status}`);

        const cm = await res.json() as { data?: Record<string, string> };
        const preferences = JSON.parse(cm.data?.preferences ?? '{}');
        return { content: [{ type: 'text' as const, text: JSON.stringify({ preferences }) }] };
      } catch (err) {
        outcome = 'error';
        throw err;
      } finally {
        end();
        toolCalls.inc({ server: SERVER_NAME, tool: 'get_user_memory', outcome });
      }
    },
  );

  server.tool(
    'set_user_memory',
    'Update a single preference key for the current user (e.g. preferredLanguage, defaultTeam, defaultOwner). Creates the record if it does not exist.',
    {
      key: z.string().describe('Preference key: preferredLanguage | defaultTeam | defaultOwner | recentServices | scaffoldCount'),
      value: z.string().describe('New value (recentServices accepts comma-separated list)'),
    },
    async ({ key, value }) => {
      const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'set_user_memory' });
      let outcome = 'success';
      try {
        const cmName = `user-memory-${memoryKey}`;
        const token = K8S_TOKEN || cachedSaToken;
        const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const getRes = await fetchWithTimeout(
          `${K8S_API}/api/v1/namespaces/${MEMORY_NS}/configmaps/${cmName}`,
          { headers },
        );

        let preferences: Record<string, unknown> = {};
        let exists = false;
        if (getRes.ok) {
          exists = true;
          const cm = await getRes.json() as { data?: Record<string, string> };
          try { preferences = JSON.parse(cm.data?.preferences ?? '{}'); } catch { preferences = {}; }
        }

        const parsedValue = key === 'recentServices'
          ? value.split(',').map(s => s.trim()).filter(Boolean)
          : key === 'scaffoldCount' ? parseInt(value, 10) || 0 : value;

        preferences[key] = parsedValue;

        const cmBody = {
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: { name: cmName, namespace: MEMORY_NS, labels: { 'app.kubernetes.io/managed-by': 'idp-mcp-server' } },
          data: { preferences: JSON.stringify(preferences) },
        };

        const method = exists ? 'PUT' : 'POST';
        const url = exists
          ? `${K8S_API}/api/v1/namespaces/${MEMORY_NS}/configmaps/${cmName}`
          : `${K8S_API}/api/v1/namespaces/${MEMORY_NS}/configmaps`;

        const putRes = await fetchWithTimeout(url, { method, headers, body: JSON.stringify(cmBody) });
        if (!putRes.ok) throw new Error(`K8s configmap ${method} returned ${putRes.status}`);

        auditLog({ action: 'user_memory_updated', memoryKey, key });
        return { content: [{ type: 'text' as const, text: JSON.stringify({ updated: { [key]: parsedValue } }) }] };
      } catch (err) {
        outcome = 'error';
        throw err;
      } finally {
        end();
        toolCalls.inc({ server: SERVER_NAME, tool: 'set_user_memory', outcome });
      }
    },
  );

  server.tool(
    'catalog_semantic_search',
    'Semantic (natural-language) search across the Backstage catalog and TechDocs using vector similarity. Use this instead of catalog_search when the query is a phrase or concept rather than an exact entity name.',
    {
      query: z.string().describe('Natural-language query, e.g. "services that handle payments" or "Go microservices owned by team-platform"'),
      limit: z.number().int().min(1).max(20).optional().describe('Max results to return (default 5)'),
    },
    async ({ query, limit = 5 }) => {
      const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'catalog_semantic_search' });
      agentToolCalls.inc({ server: SERVER_NAME, tool: 'catalog_semantic_search', agent: agentId });
      let outcome = 'success';
      try {
        const url = `${BACKSTAGE_URL}/api/rag-search/search?q=${encodeURIComponent(query)}&limit=${limit}`;
        const res = await fetchWithTimeout(url, {
          headers: {
            Authorization: `Bearer ${BACKSTAGE_TOKEN}`,
            'Content-Type': 'application/json',
          },
        });
        if (!res.ok) {
          const body = await res.text();
          throw new Error(`RAG search error ${res.status}: ${body}`);
        }
        const data = await res.json() as { results?: Array<{ title: string; text: string; location: string; score?: number }> };
        const results = (data.results ?? []).slice(0, limit);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ query, total: results.length, results }),
          }],
        };
      } catch (err) {
        outcome = 'error';
        throw err;
      } finally {
        end();
        toolCalls.inc({ server: SERVER_NAME, tool: 'catalog_semantic_search', outcome });
      }
    },
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
  const agentId = (req.get('x-agent-id') ?? req.get('user-agent') ?? 'unknown').slice(0, 64);
  // X-Backstage-User is set by the Backstage frontend on the A2A request and
  // forwarded by KAgent to MCP tool calls. Bound here at the HTTP boundary so
  // the LLM cannot influence which user's memory is accessed via tool arguments.
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
