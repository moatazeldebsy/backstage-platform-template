import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import fetch, { RequestInit } from 'node-fetch';
import { register, collectDefaultMetrics, Counter, Histogram } from 'prom-client';

const ARGOCD_URL = process.env.ARGOCD_URL ?? 'http://argocd-server.argocd.svc.cluster.local';
const ARGOCD_TOKEN = process.env.ARGOCD_TOKEN ?? '';
const PORT = parseInt(process.env.PORT ?? '3006', 10);
const HTTP_TIMEOUT_MS = parseInt(process.env.HTTP_TIMEOUT_MS ?? '15000', 10);
const SERVER_NAME = 'argocd-mcp-server';

if (!ARGOCD_TOKEN) {
  console.warn('[argocd-mcp-server] WARNING: ARGOCD_TOKEN not set — all tool calls will return 401');
}

collectDefaultMetrics();
const toolCalls = new Counter({
  name: 'mcp_tool_calls_total',
  help: 'Total MCP tool calls',
  labelNames: ['server', 'tool', 'outcome'],
});
const toolDuration = new Histogram({
  name: 'mcp_tool_duration_seconds',
  help: 'MCP tool call duration',
  labelNames: ['server', 'tool'],
});
const agentToolCalls = new Counter({
  name: 'mcp_agent_tool_calls_total',
  help: 'MCP tool calls by agent',
  labelNames: ['server', 'tool', 'agent'],
});

function auditLog(event: Record<string, unknown>): void {
  console.log('[AUDIT] ' + JSON.stringify({ ts: new Date().toISOString(), server: SERVER_NAME, ...event }));
}

async function argoFetch(path: string, init: RequestInit = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(`${ARGOCD_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${ARGOCD_TOKEN}`,
        'Content-Type': 'application/json',
        ...(init.headers as Record<string, string> ?? {}),
      },
      signal: ctrl.signal,
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

const app = express();

app.get('/healthz', (_req, res) => res.json({ status: 'ok', version: '0.1.0' }));
app.get('/ready', (_req, res) => res.json({ status: 'ready' }));
app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

function createServer(agentId: string = 'unknown') {
  const server = new McpServer({ name: SERVER_NAME, version: '0.1.0' });

  server.tool(
    'list_apps',
    'List all ArgoCD applications with their sync and health status',
    {
      project: z.string().optional().describe('Filter by ArgoCD project name'),
      namespace: z.string().optional().describe('Filter by destination namespace'),
    },
    async ({ project, namespace }) => {
      const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'list_apps' });
      agentToolCalls.inc({ server: SERVER_NAME, tool: 'list_apps', agent: agentId });
      let outcome = 'success';
      try {
        const params = new URLSearchParams();
        if (project) params.set('project', project);
        if (namespace) params.set('namespace', namespace);
        const res = await argoFetch(`/api/v1/applications?${params}`);
        if (!res.ok) throw new Error(`ArgoCD API error ${res.status}: ${await res.text()}`);
        const data = await res.json() as { items: Array<{
          metadata: { name: string; namespace: string };
          spec: { destination: { namespace: string; server: string }; project: string };
          status: { sync: { status: string }; health: { status: string }; operationState?: { phase: string; message?: string } };
        }> };
        const apps = (data.items ?? []).map(a => ({
          name: a.metadata.name,
          project: a.spec.project,
          destination_namespace: a.spec.destination.namespace,
          sync_status: a.status.sync.status,
          health_status: a.status.health.status,
          operation_phase: a.status.operationState?.phase,
        }));
        return { content: [{ type: 'text' as const, text: JSON.stringify({ total: apps.length, apps }) }] };
      } catch (err) {
        outcome = 'error';
        throw err;
      } finally {
        end();
        toolCalls.inc({ server: SERVER_NAME, tool: 'list_apps', outcome });
      }
    },
  );

  server.tool(
    'get_app_health',
    'Get the detailed health and sync status for a specific ArgoCD application',
    {
      app_name: z.string().describe('ArgoCD application name'),
    },
    async ({ app_name }) => {
      const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'get_app_health' });
      agentToolCalls.inc({ server: SERVER_NAME, tool: 'get_app_health', agent: agentId });
      let outcome = 'success';
      try {
        const res = await argoFetch(`/api/v1/applications/${encodeURIComponent(app_name)}`);
        if (!res.ok) throw new Error(`ArgoCD API error ${res.status}: ${await res.text()}`);
        const a = await res.json() as {
          metadata: { name: string; creationTimestamp: string };
          spec: { source: { repoURL: string; targetRevision: string; path: string }; project: string; destination: { namespace: string } };
          status: {
            sync: { status: string; revision: string };
            health: { status: string; message?: string };
            operationState?: { phase: string; message?: string; startedAt: string; finishedAt?: string };
            conditions?: Array<{ type: string; message: string }>;
          };
        };
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              name: a.metadata.name,
              project: a.spec.project,
              repo: a.spec.source.repoURL,
              path: a.spec.source.path,
              target_revision: a.spec.source.targetRevision,
              destination_namespace: a.spec.destination.namespace,
              sync_status: a.status.sync.status,
              sync_revision: a.status.sync.revision,
              health_status: a.status.health.status,
              health_message: a.status.health.message,
              operation: a.status.operationState
                ? { phase: a.status.operationState.phase, message: a.status.operationState.message, started_at: a.status.operationState.startedAt, finished_at: a.status.operationState.finishedAt }
                : null,
              conditions: a.status.conditions ?? [],
            }),
          }],
        };
      } catch (err) {
        outcome = 'error';
        throw err;
      } finally {
        end();
        toolCalls.inc({ server: SERVER_NAME, tool: 'get_app_health', outcome });
      }
    },
  );

  server.tool(
    'get_app_diff',
    'Get the live vs desired diff for an out-of-sync ArgoCD application',
    {
      app_name: z.string().describe('ArgoCD application name'),
    },
    async ({ app_name }) => {
      const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'get_app_diff' });
      agentToolCalls.inc({ server: SERVER_NAME, tool: 'get_app_diff', agent: agentId });
      let outcome = 'success';
      try {
        const res = await argoFetch(`/api/v1/applications/${encodeURIComponent(app_name)}/managed-resources`);
        if (!res.ok) throw new Error(`ArgoCD API error ${res.status}: ${await res.text()}`);
        const data = await res.json() as { items: Array<{ group: string; version: string; kind: string; name: string; namespace: string; status: string; hook: boolean; requiresPruning?: boolean }> };
        const drifted = (data.items ?? []).filter(r => r.status !== 'Synced');
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              app: app_name,
              total_resources: data.items?.length ?? 0,
              drifted_count: drifted.length,
              drifted_resources: drifted.map(r => ({
                kind: r.kind,
                name: r.name,
                namespace: r.namespace,
                status: r.status,
                requires_pruning: r.requiresPruning ?? false,
              })),
            }),
          }],
        };
      } catch (err) {
        outcome = 'error';
        throw err;
      } finally {
        end();
        toolCalls.inc({ server: SERVER_NAME, tool: 'get_app_diff', outcome });
      }
    },
  );

  server.tool(
    'sync_app',
    'Trigger a sync for an ArgoCD application to reconcile it with the Git source',
    {
      app_name: z.string().describe('ArgoCD application name'),
      revision: z.string().optional().describe('Git revision to sync to (defaults to HEAD of configured branch)'),
      prune: z.boolean().optional().describe('Remove resources not in Git (default false — safer)'),
      dry_run: z.boolean().optional().describe('If true, simulate the sync without applying changes'),
    },
    async ({ app_name, revision, prune = false, dry_run = false }) => {
      const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'sync_app' });
      agentToolCalls.inc({ server: SERVER_NAME, tool: 'sync_app', agent: agentId });
      let outcome = 'success';
      auditLog({ action: 'sync_app_requested', agent: agentId, app: app_name, revision, prune, dry_run });
      try {
        if (dry_run) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ dry_run: true, app: app_name, revision: revision ?? 'HEAD', prune, message: 'Dry run — no sync triggered. Remove dry_run: true to proceed.' }),
            }],
          };
        }
        const body: Record<string, unknown> = { prune };
        if (revision) body.revision = revision;
        const res = await argoFetch(`/api/v1/applications/${encodeURIComponent(app_name)}/sync`, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`ArgoCD API error ${res.status}: ${await res.text()}`);
        const data = await res.json() as { metadata: { name: string }; status: { operationState?: { phase: string; message?: string } } };
        auditLog({ action: 'sync_app_triggered', agent: agentId, app: app_name, revision, prune });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              app: data.metadata.name,
              operation_phase: data.status.operationState?.phase ?? 'Running',
              message: data.status.operationState?.message ?? 'Sync triggered — check get_app_health for status',
            }),
          }],
        };
      } catch (err) {
        outcome = 'error';
        throw err;
      } finally {
        end();
        toolCalls.inc({ server: SERVER_NAME, tool: 'sync_app', outcome });
      }
    },
  );

  server.tool(
    'rollback_app',
    'Rollback an ArgoCD application to a previous deployed revision',
    {
      app_name: z.string().describe('ArgoCD application name'),
      revision_id: z.number().int().describe('History revision ID to rollback to (from get_app_health history)'),
      dry_run: z.boolean().optional().describe('If true, show what would be rolled back without doing it'),
    },
    async ({ app_name, revision_id, dry_run = false }) => {
      const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'rollback_app' });
      agentToolCalls.inc({ server: SERVER_NAME, tool: 'rollback_app', agent: agentId });
      let outcome = 'success';
      auditLog({ action: 'rollback_app_requested', agent: agentId, app: app_name, revision_id, dry_run });
      try {
        if (dry_run) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ dry_run: true, app: app_name, revision_id, message: 'Dry run — no rollback triggered. Remove dry_run: true to proceed.' }),
            }],
          };
        }
        const res = await argoFetch(`/api/v1/applications/${encodeURIComponent(app_name)}/rollback`, {
          method: 'POST',
          body: JSON.stringify({ id: revision_id }),
        });
        if (!res.ok) throw new Error(`ArgoCD API error ${res.status}: ${await res.text()}`);
        const data = await res.json() as { metadata: { name: string }; status: { operationState?: { phase: string; message?: string } } };
        auditLog({ action: 'rollback_app_triggered', agent: agentId, app: app_name, revision_id });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              app: data.metadata.name,
              rollback_to: revision_id,
              operation_phase: data.status.operationState?.phase ?? 'Running',
              message: data.status.operationState?.message ?? 'Rollback triggered — check get_app_health for status',
            }),
          }],
        };
      } catch (err) {
        outcome = 'error';
        throw err;
      } finally {
        end();
        toolCalls.inc({ server: SERVER_NAME, tool: 'rollback_app', outcome });
      }
    },
  );

  return server;
}

app.post('/mcp', express.json(), async (req, res) => {
  const agentId = (req.get('x-agent-id') ?? req.get('user-agent') ?? 'unknown').slice(0, 64);
  const srv = createServer(agentId);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await srv.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(PORT, () => {
  console.log(`ArgoCD MCP Server listening on :${PORT}`);
});
