import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fetch, { RequestInit } from 'node-fetch';
import { Counter, Histogram } from 'prom-client';
import fs from 'fs';
import { TtlCache, sanitizeUserId, normalizeRepoUrl, parseTemplateRef, parseMemoryValue } from './utils.js';

// ── Config ────────────────────────────────────────────────────────────────

export const BACKSTAGE_URL          = process.env.BACKSTAGE_URL          ?? 'http://backstage:7007';
export const BACKSTAGE_EXTERNAL_URL = process.env.BACKSTAGE_EXTERNAL_URL ?? 'http://backstage.idp.local';
export const BACKSTAGE_TOKEN        = process.env.BACKSTAGE_TOKEN        ?? '';
export const PROMETHEUS_URL         = process.env.PROMETHEUS_URL         ?? 'http://prometheus-kube-prometheus-prometheus.monitoring:9090';
export const K8S_API                = process.env.K8S_API                ?? 'https://kubernetes.default.svc';
export const K8S_TOKEN              = process.env.K8S_TOKEN              ?? '';
export const HTTP_TIMEOUT_MS        = parseInt(process.env.HTTP_TIMEOUT_MS ?? '8000', 10);

// ── Module-scoped caches (survive across per-request McpServer instances) ─

export const templateListCache   = new TtlCache<unknown[]>();
export const templateParamsCache = new TtlCache<unknown>();
export const catalogSearchCache  = new TtlCache<unknown[]>();

export function clearAllCaches(): void {
  templateListCache.clear();
  templateParamsCache.clear();
  catalogSearchCache.clear();
}

// ── Service-account token ─────────────────────────────────────────────────

const SA_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';
export let cachedSaToken = '';
try {
  if (fs.existsSync(SA_TOKEN_PATH)) {
    cachedSaToken = fs.readFileSync(SA_TOKEN_PATH, 'utf8').trim();
    fs.watch(SA_TOKEN_PATH, { persistent: false }, () => {
      try { cachedSaToken = fs.readFileSync(SA_TOKEN_PATH, 'utf8').trim(); }
      catch { /* keep last good token */ }
    });
  }
} catch { /* not in-cluster; K8S_TOKEN env var used instead */ }

// ── Metrics ───────────────────────────────────────────────────────────────

export const SERVER_NAME = 'idp-mcp-server';
export const toolCalls     = new Counter({ name: 'mcp_tool_calls_total',       help: 'Total MCP tool calls',                    labelNames: ['server', 'tool', 'outcome'] });
export const toolDuration  = new Histogram({ name: 'mcp_tool_duration_seconds', help: 'MCP tool call duration',                 labelNames: ['server', 'tool'] });
export const agentToolCalls = new Counter({ name: 'mcp_agent_tool_calls_total', help: 'Tool calls attributed per calling agent', labelNames: ['server', 'tool', 'agent'] });

export function auditLog(event: Record<string, unknown>): void {
  console.log('[AUDIT] ' + JSON.stringify({ ts: new Date().toISOString(), server: SERVER_NAME, ...event }));
}

// ── HTTP helpers ──────────────────────────────────────────────────────────

export async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = HTTP_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchCatalog(path: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (BACKSTAGE_TOKEN) headers['Authorization'] = `Bearer ${BACKSTAGE_TOKEN}`;
  const res = await fetchWithTimeout(`${BACKSTAGE_URL}${path}`, { headers });
  if (!res.ok) throw new Error(`Backstage API error ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function fetchPrometheus(query: string) {
  const url = `${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(query)}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Prometheus error ${res.status}`);
  return res.json() as Promise<{ data: { result: Array<{ metric: Record<string, string>; value: [number, string] }> } }>;
}

export async function fetchK8s(path: string) {
  const token = K8S_TOKEN || cachedSaToken;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetchWithTimeout(`${K8S_API}${path}`, { headers });
  if (!res.ok) throw new Error(`K8s API error ${res.status}`);
  return res.json() as Promise<{ items: Array<Record<string, unknown>> }>;
}

// ── MCP Server factory ────────────────────────────────────────────────────
// Stateless Streamable HTTP requires a fresh McpServer per request.
// agentId comes from X-Agent-ID; userRef from X-Backstage-User.
// userRef is bound here at the HTTP boundary — LLM tool arguments cannot
// override it, preventing cross-user IDOR on memory operations.

export function createServer(agentId = 'unknown', userRef = '') {
  const server = new McpServer({ name: 'idp-mcp-server', version: '1.0.0' });

  // ── catalog_search ────────────────────────────────────────────────────

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
        const kindParam = kind ? `filter=kind=${kind}&` : '';
        const cacheKey = `${kind ?? ''}:${query}`;
        const cached = catalogSearchCache.get(cacheKey);
        if (cached) return { content: [{ type: 'text' as const, text: JSON.stringify(cached, null, 2) }] };

        const data = await fetchCatalog(`/api/catalog/entities?${kindParam}filter=metadata.name=${encodeURIComponent(query)}`) as unknown[];
        type CatalogEntity = { metadata: { name: string; description?: string }; kind: string; spec?: { owner?: string; type?: string } };
        let results: Array<{ name: string; kind: string; type?: string; owner?: string; description?: string }>;

        if (!Array.isArray(data) || data.length === 0) {
          const all = await fetchCatalog(`/api/catalog/entities?${kindParam}limit=200`) as CatalogEntity[];
          results = all
            .filter(e =>
              e.metadata.name.toLowerCase().includes(query.toLowerCase()) ||
              (e.metadata.description ?? '').toLowerCase().includes(query.toLowerCase())
            )
            .slice(0, 10)
            .map(e => ({ name: e.metadata.name, kind: e.kind, type: e.spec?.type, owner: e.spec?.owner, description: e.metadata.description }));
        } else {
          results = (data as CatalogEntity[]).map(e => ({
            name: e.metadata.name, kind: e.kind, type: e.spec?.type, owner: e.spec?.owner, description: e.metadata.description,
          }));
        }
        catalogSearchCache.set(cacheKey, results, 30_000);
        return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
      } catch (err) { outcome = 'error'; throw err; }
      finally { end(); toolCalls.inc({ server: SERVER_NAME, tool: 'catalog_search', outcome }); }
    },
  );

  // ── get_service_metrics ───────────────────────────────────────────────

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
        const data = await fetchPrometheus(`${metric}{job="${service_name}"}`);
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
      } catch (err) { outcome = 'error'; throw err; }
      finally { end(); toolCalls.inc({ server: SERVER_NAME, tool: 'get_service_metrics', outcome }); }
    },
  );

  // ── scaffold_service ──────────────────────────────────────────────────

  server.tool(
    'scaffold_service',
    'Trigger a Backstage scaffolder template to create a new service.',
    {
      template_ref: z.string().describe('Template entity ref, e.g. template:default/nodejs-service'),
      values: z.record(z.string(), z.unknown()).describe('Template parameter values.'),
      dry_run: z.boolean().optional().describe('If true, validate and preview without calling the Backstage API.'),
    },
    async ({ template_ref, values, dry_run }) => {
      const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'scaffold_service' });
      agentToolCalls.inc({ server: SERVER_NAME, tool: 'scaffold_service', agent: agentId });
      let outcome = 'success';
      try {
        const enrichedValues: Record<string, unknown> = { ...values };
        enrichedValues['repoUrl'] = normalizeRepoUrl(enrichedValues);

        auditLog({ action: 'scaffold_service_requested', agent: agentId, template: template_ref, service: enrichedValues['name'], dry_run: !!dry_run });

        if (dry_run) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ dry_run: true, message: 'Dry run — no service created. Review the parameters below, then call scaffold_service again without dry_run to proceed.', template: template_ref, values: enrichedValues }, null, 2),
            }],
          };
        }

        const authHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
        if (BACKSTAGE_TOKEN) authHeaders['Authorization'] = `Bearer ${BACKSTAGE_TOKEN}`;
        const res = await fetchWithTimeout(`${BACKSTAGE_URL}/api/scaffolder/v2/tasks`, {
          method: 'POST', headers: authHeaders,
          body: JSON.stringify({ templateRef: template_ref, values: enrichedValues }),
        });
        if (!res.ok) throw new Error(`Scaffolder error ${res.status}: ${await res.text()}`);
        const task = await res.json() as { id: string };

        // Poll for completion with exponential backoff + jitter.
        const pollHeaders: Record<string, string> = {};
        if (BACKSTAGE_TOKEN) pollHeaders['Authorization'] = `Bearer ${BACKSTAGE_TOKEN}`;
        const deadline = Date.now() + 180_000;
        let taskStatus = 'processing';
        let taskOutput: unknown;
        let attempt = 0;
        while (Date.now() < deadline) {
          const base = Math.min(4000, 500 * Math.pow(2, attempt));
          await new Promise(r => setTimeout(r, base * (0.8 + Math.random() * 0.4)));
          attempt++;
          const statusRes = await fetchWithTimeout(`${BACKSTAGE_URL}/api/scaffolder/v2/tasks/${task.id}`, { headers: pollHeaders });
          if (statusRes.ok) {
            const body = await statusRes.json() as { status: string; output?: unknown };
            taskStatus = body.status;
            taskOutput = body.output;
            if (taskStatus === 'completed' || taskStatus === 'failed' || taskStatus === 'cancelled') break;
          }
        }

        auditLog({ action: 'scaffold_service_completed', agent: agentId, template: template_ref, task_id: task.id, status: taskStatus });
        if (taskStatus === 'failed') outcome = 'error';

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ task_id: task.id, status: taskStatus, output: taskOutput, ui_url: `${BACKSTAGE_EXTERNAL_URL}/create/tasks/${task.id}` }, null, 2),
          }],
        };
      } catch (err) {
        outcome = 'error';
        auditLog({ action: 'scaffold_service_error', agent: agentId, error: String(err) });
        throw err;
      } finally { end(); toolCalls.inc({ server: SERVER_NAME, tool: 'scaffold_service', outcome }); }
    },
  );

  // ── list_deployments ──────────────────────────────────────────────────

  server.tool(
    'list_deployments',
    'List Kubernetes Deployments and their readiness status.',
    { namespace: z.string().optional().describe('K8s namespace. Omit to query services-dev and services.') },
    async ({ namespace }) => {
      const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'list_deployments' });
      agentToolCalls.inc({ server: SERVER_NAME, tool: 'list_deployments', agent: agentId });
      let outcome = 'success';
      try {
        const namespacesToQuery = namespace ? [namespace] : ['services-dev', 'services'];
        const allDeployments: unknown[] = [];
        for (const ns of namespacesToQuery) {
          const data = await fetchK8s(`/apis/apps/v1/namespaces/${ns}/deployments`);
          allDeployments.push(...data.items.map((d: Record<string, unknown>) => {
            const meta     = d['metadata'] as Record<string, unknown>;
            const spec     = d['spec']     as Record<string, unknown>;
            const status   = d['status']   as Record<string, unknown>;
            const containers = ((spec['template'] as Record<string, unknown>)?.['spec'] as Record<string, unknown>);
            const first    = (containers?.['containers'] as Array<Record<string, unknown>>)?.[0];
            return { name: meta['name'], namespace: meta['namespace'], replicas: spec['replicas'], ready_replicas: status['readyReplicas'] ?? 0, image: first?.['image'] ?? 'unknown' };
          }));
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(allDeployments, null, 2) }] };
      } catch (err) { outcome = 'error'; throw err; }
      finally { end(); toolCalls.inc({ server: SERVER_NAME, tool: 'list_deployments', outcome }); }
    },
  );

  // ── list_templates ────────────────────────────────────────────────────

  server.tool(
    'list_templates',
    'List all available Backstage scaffolder templates.',
    {},
    async () => {
      const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'list_templates' });
      agentToolCalls.inc({ server: SERVER_NAME, tool: 'list_templates', agent: agentId });
      let outcome = 'success';
      try {
        const hit = templateListCache.get('all');
        if (hit) return { content: [{ type: 'text' as const, text: JSON.stringify(hit, null, 2) }] };
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
        templateListCache.set('all', templates, 60_000);
        return { content: [{ type: 'text' as const, text: JSON.stringify(templates, null, 2) }] };
      } catch (err) { outcome = 'error'; throw err; }
      finally { end(); toolCalls.inc({ server: SERVER_NAME, tool: 'list_templates', outcome }); }
    },
  );

  // ── get_template_params ───────────────────────────────────────────────

  server.tool(
    'get_template_params',
    'Fetch the exact parameter schema for a Backstage scaffolder template.',
    { template_ref: z.string().describe('Template entity ref, e.g. template:default/nodejs-service') },
    async ({ template_ref }) => {
      const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'get_template_params' });
      agentToolCalls.inc({ server: SERVER_NAME, tool: 'get_template_params', agent: agentId });
      let outcome = 'success';
      try {
        const cached = templateParamsCache.get(template_ref);
        if (cached) return { content: [{ type: 'text' as const, text: JSON.stringify(cached, null, 2) }] };
        const { namespace, name } = parseTemplateRef(template_ref);
        const entity = await fetchCatalog(`/api/catalog/entities/by-name/Template/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`) as {
          metadata: { name: string; title?: string; description?: string };
          spec?: { parameters?: Array<{ title?: string; required?: string[]; properties?: Record<string, unknown> }> };
        };
        const result = { name: entity.metadata.name, title: entity.metadata.title, description: entity.metadata.description, parameters: entity.spec?.parameters ?? [] };
        templateParamsCache.set(template_ref, result, 120_000);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) { outcome = 'error'; throw err; }
      finally { end(); toolCalls.inc({ server: SERVER_NAME, tool: 'get_template_params', outcome }); }
    },
  );

  // ── User memory ───────────────────────────────────────────────────────
  // Stored in ConfigMap user-memory-<sanitized-userId> in the kagent namespace.
  // memoryKey is derived at factory time from X-Backstage-User, not from tool
  // arguments, to prevent cross-user IDOR.

  const MEMORY_NS = 'kagent';
  const memoryKey = userRef ? sanitizeUserId(userRef) : `agent-${sanitizeUserId(agentId)}`;
  // sanitizeUserId already strips everything but [a-z0-9-]; this re-check is
  // the hard gate against path-injection into the K8s API URL below.
  if (!/^[a-z0-9-]{1,70}$/.test(memoryKey)) {
    throw new Error('Invalid memoryKey derived from user/agent identifiers');
  }

  server.tool(
    'get_user_memory',
    'Retrieve persistent preferences for the current user.',
    {},
    async () => {
      const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'get_user_memory' });
      let outcome = 'success';
      try {
        const cmName = `user-memory-${memoryKey}`;
        const token = K8S_TOKEN || cachedSaToken;
        const headers: Record<string, string> = { Accept: 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const res = await fetchWithTimeout(`${K8S_API}/api/v1/namespaces/${MEMORY_NS}/configmaps/${encodeURIComponent(cmName)}`, { headers });
        if (res.status === 404) return { content: [{ type: 'text' as const, text: JSON.stringify({ preferences: {} }) }] };
        if (!res.ok) throw new Error(`K8s configmap GET returned ${res.status}`);
        const cm = await res.json() as { data?: Record<string, string> };
        return { content: [{ type: 'text' as const, text: JSON.stringify({ preferences: JSON.parse(cm.data?.preferences ?? '{}') }) }] };
      } catch (err) { outcome = 'error'; throw err; }
      finally { end(); toolCalls.inc({ server: SERVER_NAME, tool: 'get_user_memory', outcome }); }
    },
  );

  server.tool(
    'set_user_memory',
    'Update a single preference key for the current user.',
    {
      key: z.string().describe('Preference key'),
      value: z.string().describe('New value'),
    },
    async ({ key, value }) => {
      const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'set_user_memory' });
      let outcome = 'success';
      try {
        const cmName = `user-memory-${memoryKey}`;
        const token = K8S_TOKEN || cachedSaToken;
        const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const getRes = await fetchWithTimeout(`${K8S_API}/api/v1/namespaces/${MEMORY_NS}/configmaps/${encodeURIComponent(cmName)}`, { headers });
        let preferences: Record<string, unknown> = {};
        let exists = false;
        if (getRes.ok) {
          exists = true;
          const cm = await getRes.json() as { data?: Record<string, string> };
          try { preferences = JSON.parse(cm.data?.preferences ?? '{}'); } catch { preferences = {}; }
        }

        const parsedValue = parseMemoryValue(key, value);
        preferences[key] = parsedValue;

        const cmBody = { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: cmName, namespace: MEMORY_NS, labels: { 'app.kubernetes.io/managed-by': 'idp-mcp-server' } }, data: { preferences: JSON.stringify(preferences) } };
        const method = exists ? 'PUT' : 'POST';
        const url = exists ? `${K8S_API}/api/v1/namespaces/${MEMORY_NS}/configmaps/${encodeURIComponent(cmName)}` : `${K8S_API}/api/v1/namespaces/${MEMORY_NS}/configmaps`;
        const putRes = await fetchWithTimeout(url, { method, headers, body: JSON.stringify(cmBody) });
        if (!putRes.ok) throw new Error(`K8s configmap ${method} returned ${putRes.status}`);

        auditLog({ action: 'user_memory_updated', memoryKey, key });
        return { content: [{ type: 'text' as const, text: JSON.stringify({ updated: { [key]: parsedValue } }) }] };
      } catch (err) { outcome = 'error'; throw err; }
      finally { end(); toolCalls.inc({ server: SERVER_NAME, tool: 'set_user_memory', outcome }); }
    },
  );

  // ── catalog_semantic_search ───────────────────────────────────────────

  server.tool(
    'catalog_semantic_search',
    'Semantic natural-language search across the Backstage catalog and TechDocs.',
    {
      query: z.string().describe('Natural-language query'),
      limit: z.number().int().min(1).max(20).optional().describe('Max results (default 5)'),
    },
    async ({ query, limit = 5 }) => {
      const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'catalog_semantic_search' });
      agentToolCalls.inc({ server: SERVER_NAME, tool: 'catalog_semantic_search', agent: agentId });
      let outcome = 'success';
      try {
        const url = `${BACKSTAGE_URL}/api/rag-search/search?q=${encodeURIComponent(query)}&limit=${limit}`;
        const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${BACKSTAGE_TOKEN}`, 'Content-Type': 'application/json' } });
        if (!res.ok) throw new Error(`RAG search error ${res.status}: ${await res.text()}`);
        const data = await res.json() as { results?: Array<{ title: string; text: string; location: string; score?: number }> };
        const results = (data.results ?? []).slice(0, limit);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ query, total: results.length, results }) }] };
      } catch (err) { outcome = 'error'; throw err; }
      finally { end(); toolCalls.inc({ server: SERVER_NAME, tool: 'catalog_semantic_search', outcome }); }
    },
  );

  return server;
}
