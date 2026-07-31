import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fetch, { RequestInit } from 'node-fetch';
import fs from 'fs';
import { Counter, Histogram } from 'prom-client';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? '';
const GITHUB_API = process.env.GITHUB_API ?? 'https://api.github.com';
const K8S_API = process.env.K8S_API ?? 'https://kubernetes.default.svc';
const K8S_TOKEN = process.env.K8S_TOKEN ?? '';
const HTTP_TIMEOUT_MS = parseInt(process.env.HTTP_TIMEOUT_MS ?? '10000', 10);
export const SERVER_NAME = 'security-mcp-server';

export const toolCalls = new Counter({
  name: 'mcp_tool_calls_total',
  help: 'Total MCP tool calls',
  labelNames: ['server', 'tool', 'outcome'],
});
export const toolDuration = new Histogram({
  name: 'mcp_tool_duration_seconds',
  help: 'MCP tool call duration',
  labelNames: ['server', 'tool'],
});
export const agentToolCalls = new Counter({
  name: 'mcp_agent_tool_calls_total',
  help: 'MCP tool calls by agent',
  labelNames: ['server', 'tool', 'agent'],
});

const SA_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';
let cachedSaToken = '';
try {
  if (fs.existsSync(SA_TOKEN_PATH)) cachedSaToken = fs.readFileSync(SA_TOKEN_PATH, 'utf8').trim();
} catch { /* not in-cluster; K8S_TOKEN env var used instead */ }

export async function fetchWithTimeout(url: string, init: RequestInit = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function ghFetch(path: string, init: RequestInit = {}) {
  return fetchWithTimeout(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers as Record<string, string> ?? {}),
    },
  });
}

async function fetchK8s(path: string) {
  const token = K8S_TOKEN || cachedSaToken;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetchWithTimeout(`${K8S_API}${path}`, { headers });
}

export function createServer(agentId: string = 'unknown') {
  const server = new McpServer({ name: SERVER_NAME, version: '0.1.0' });

  server.tool(
    'list_vulnerable_deps',
    'List open Dependabot alerts (vulnerable dependencies) for a repository',
    {
      repo: z.string().describe('Full repo name e.g. org/my-service'),
      severity: z.enum(['low', 'medium', 'high', 'critical']).optional().describe('Filter by severity'),
    },
    async ({ repo, severity }) => {
      const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'list_vulnerable_deps' });
      agentToolCalls.inc({ server: SERVER_NAME, tool: 'list_vulnerable_deps', agent: agentId });
      let outcome = 'success';
      try {
        const params = new URLSearchParams({ state: 'open' });
        if (severity) params.set('severity', severity);
        const res = await ghFetch(`/repos/${repo}/dependabot/alerts?${params}`);
        if (!res.ok) throw new Error(`GitHub API error ${res.status}: ${await res.text()}`);
        const alerts = await res.json() as Array<{
          number: number;
          security_advisory: { summary: string; severity: string; cve_id?: string };
          dependency: { package: { name: string; ecosystem: string } };
          html_url: string;
        }>;
        const results = alerts.map(a => ({
          alert_number: a.number,
          package: a.dependency.package.name,
          ecosystem: a.dependency.package.ecosystem,
          severity: a.security_advisory.severity,
          summary: a.security_advisory.summary,
          cve: a.security_advisory.cve_id,
          url: a.html_url,
        }));
        return { content: [{ type: 'text' as const, text: JSON.stringify({ repo, total: results.length, alerts: results }) }] };
      } catch (err) {
        outcome = 'error';
        throw err;
      } finally {
        end();
        toolCalls.inc({ server: SERVER_NAME, tool: 'list_vulnerable_deps', outcome });
      }
    },
  );

  server.tool(
    'get_secret_rotation_status',
    'List open secret-rotation reminder issues for a repository (created by the secret-rotation scaffolder template)',
    {
      repo: z.string().describe('Full repo name e.g. org/my-service'),
    },
    async ({ repo }) => {
      const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'get_secret_rotation_status' });
      agentToolCalls.inc({ server: SERVER_NAME, tool: 'get_secret_rotation_status', agent: agentId });
      let outcome = 'success';
      try {
        const res = await ghFetch(`/repos/${repo}/issues?labels=secret-rotation&state=open`);
        if (!res.ok) throw new Error(`GitHub API error ${res.status}: ${await res.text()}`);
        const issues = await res.json() as Array<{ number: number; title: string; html_url: string; created_at: string }>;
        const pending = issues.map(i => ({ issue_number: i.number, title: i.title, url: i.html_url, opened_at: i.created_at }));
        return { content: [{ type: 'text' as const, text: JSON.stringify({ repo, pending_rotations: pending.length, issues: pending }) }] };
      } catch (err) {
        outcome = 'error';
        throw err;
      } finally {
        end();
        toolCalls.inc({ server: SERVER_NAME, tool: 'get_secret_rotation_status', outcome });
      }
    },
  );

  server.tool(
    'list_policy_violations',
    'List Kyverno policy violations (failed PolicyReport/ClusterPolicyReport results) across the cluster',
    {
      namespace: z.string().optional().describe('Limit to a specific namespace (defaults to all namespaces via ClusterPolicyReports + every namespaced PolicyReport)'),
    },
    async ({ namespace }) => {
      const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'list_policy_violations' });
      agentToolCalls.inc({ server: SERVER_NAME, tool: 'list_policy_violations', agent: agentId });
      let outcome = 'success';
      try {
        const path = namespace
          ? `/apis/wgpolicyk8s.io/v1alpha2/namespaces/${encodeURIComponent(namespace)}/policyreports`
          : `/apis/wgpolicyk8s.io/v1alpha2/policyreports`;
        const res = await fetchK8s(path);
        if (!res.ok) throw new Error(`Kubernetes API error ${res.status}: ${await res.text()}`);
        const data = await res.json() as { items: Array<{
          metadata: { name: string; namespace?: string };
          results?: Array<{ policy: string; rule: string; result: string; resources?: Array<{ kind: string; name: string }>; message?: string }>;
        }> };
        const violations = (data.items ?? []).flatMap(report =>
          (report.results ?? [])
            .filter(r => r.result === 'fail')
            .map(r => ({
              namespace: report.metadata.namespace ?? namespace ?? 'cluster-scoped',
              policy: r.policy,
              rule: r.rule,
              resources: (r.resources ?? []).map(res => `${res.kind}/${res.name}`),
              message: r.message,
            })),
        );
        return { content: [{ type: 'text' as const, text: JSON.stringify({ total: violations.length, violations }) }] };
      } catch (err) {
        outcome = 'error';
        throw err;
      } finally {
        end();
        toolCalls.inc({ server: SERVER_NAME, tool: 'list_policy_violations', outcome });
      }
    },
  );

  return server;
}
