import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fetch, { RequestInit } from 'node-fetch';
import { Counter, Histogram } from 'prom-client';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? '';
const GITHUB_API = process.env.GITHUB_API ?? 'https://api.github.com';
const INCIDENT_REPO = process.env.INCIDENT_REPO ?? '';
const PROMETHEUS_URL = process.env.PROMETHEUS_URL ?? 'http://prometheus-kube-prometheus-prometheus.monitoring:9090';
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL ?? '';
const HTTP_TIMEOUT_MS = parseInt(process.env.HTTP_TIMEOUT_MS ?? '10000', 10);
export const SERVER_NAME = 'incident-mcp-server';

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

export function auditLog(event: Record<string, unknown>): void {
  console.log('[AUDIT] ' + JSON.stringify({ ts: new Date().toISOString(), server: SERVER_NAME, ...event }));
}

export async function fetchWithTimeout(url: string, init: RequestInit = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function githubHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

// Matches the label scheme agent-event-router's createIncidentIssue/resolveIncidentIssue
// use, so this tool reads back exactly what that automation writes.
export async function ghFetch(path: string, init: RequestInit = {}) {
  return fetchWithTimeout(`${GITHUB_API}${path}`, { ...init, headers: { ...githubHeaders(), ...(init.headers as Record<string, string> ?? {}) } });
}

export function createServer(agentId: string = 'unknown') {
  const server = new McpServer({ name: SERVER_NAME, version: '0.1.0' });

  server.tool(
    'get_open_incidents',
    'List currently open incidents (GitHub issues labelled "incident:open"), as tracked by agent-event-router when critical alerts fire',
    {
      severity: z.string().optional().describe('Filter by severity label, e.g. "critical" or "warning"'),
    },
    async ({ severity }) => {
      const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'get_open_incidents' });
      agentToolCalls.inc({ server: SERVER_NAME, tool: 'get_open_incidents', agent: agentId });
      let outcome = 'success';
      try {
        if (!INCIDENT_REPO) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ incidents: [], message: 'INCIDENT_REPO not configured — no incident tracking repo to query.' }) }] };
        }
        const labels = severity ? `incident:open,severity:${severity}` : 'incident:open';
        const res = await ghFetch(`/repos/${INCIDENT_REPO}/issues?labels=${encodeURIComponent(labels)}&state=open`);
        if (!res.ok) throw new Error(`GitHub API error ${res.status}: ${await res.text()}`);
        const issues = await res.json() as Array<{ number: number; title: string; html_url: string; created_at: string; labels: Array<{ name: string } | string> }>;
        const incidents = issues.map(i => ({
          issue_number: i.number,
          title: i.title,
          url: i.html_url,
          created_at: i.created_at,
          labels: i.labels.map(l => typeof l === 'string' ? l : l.name),
        }));
        return { content: [{ type: 'text' as const, text: JSON.stringify({ total: incidents.length, incidents }) }] };
      } catch (err) {
        outcome = 'error';
        throw err;
      } finally {
        end();
        toolCalls.inc({ server: SERVER_NAME, tool: 'get_open_incidents', outcome });
      }
    },
  );

  server.tool(
    'get_alert_history',
    'Get recent AlertManager alert activity from Prometheus (ALERTS metric) over a time window',
    {
      alertname: z.string().optional().describe('Filter to a specific alert name'),
      hours: z.number().int().min(1).max(168).default(24).describe('How many hours back to look (default 24, max 168)'),
    },
    async ({ alertname, hours }) => {
      const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'get_alert_history' });
      agentToolCalls.inc({ server: SERVER_NAME, tool: 'get_alert_history', agent: agentId });
      let outcome = 'success';
      try {
        const query = alertname ? `ALERTS{alertname="${alertname}"}` : 'ALERTS{alertstate="firing"}';
        const end_ts = Math.floor(Date.now() / 1000);
        const start_ts = end_ts - hours * 3600;
        const params = new URLSearchParams({ query, start: String(start_ts), end: String(end_ts), step: '5m' });
        const res = await fetchWithTimeout(`${PROMETHEUS_URL}/api/v1/query_range?${params}`);
        if (!res.ok) throw new Error(`Prometheus API error ${res.status}: ${await res.text()}`);
        const data = await res.json() as { data?: { result?: Array<{ metric: Record<string, string>; values: [number, string][] }> } };
        const series = data.data?.result ?? [];
        const alerts = series.map(s => {
          const timestamps = s.values.map(v => v[0]);
          return {
            alertname: s.metric.alertname,
            severity: s.metric.severity,
            namespace: s.metric.namespace,
            alertstate: s.metric.alertstate,
            first_seen: timestamps.length ? new Date(timestamps[0] * 1000).toISOString() : null,
            last_seen: timestamps.length ? new Date(timestamps[timestamps.length - 1] * 1000).toISOString() : null,
            sample_count: timestamps.length,
          };
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify({ window_hours: hours, total: alerts.length, alerts }) }] };
      } catch (err) {
        outcome = 'error';
        throw err;
      } finally {
        end();
        toolCalls.inc({ server: SERVER_NAME, tool: 'get_alert_history', outcome });
      }
    },
  );

  server.tool(
    'get_runbook',
    'Fetch a runbook markdown file from docs/runbooks/ in the platform repo',
    {
      name: z.string().describe('Runbook filename without extension, e.g. "dr-region-failover" or "kagent-guardrails"'),
    },
    async ({ name }) => {
      const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'get_runbook' });
      agentToolCalls.inc({ server: SERVER_NAME, tool: 'get_runbook', agent: agentId });
      let outcome = 'success';
      try {
        if (!INCIDENT_REPO) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ message: 'INCIDENT_REPO not configured — cannot fetch runbooks.' }) }] };
        }
        const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '');
        const res = await ghFetch(`/repos/${INCIDENT_REPO}/contents/docs/runbooks/${safeName}.md`);
        if (res.status === 404) {
          const listRes = await ghFetch(`/repos/${INCIDENT_REPO}/contents/docs/runbooks`);
          const available = listRes.ok ? (await listRes.json() as Array<{ name: string }>).map(f => f.name.replace(/\.md$/, '')) : [];
          return { content: [{ type: 'text' as const, text: JSON.stringify({ found: false, name: safeName, available_runbooks: available }) }] };
        }
        if (!res.ok) throw new Error(`GitHub API error ${res.status}: ${await res.text()}`);
        const file = await res.json() as { content: string; encoding: string };
        const text = Buffer.from(file.content, file.encoding as BufferEncoding).toString('utf-8');
        return { content: [{ type: 'text' as const, text: JSON.stringify({ found: true, name: safeName, content: text }) }] };
      } catch (err) {
        outcome = 'error';
        throw err;
      } finally {
        end();
        toolCalls.inc({ server: SERVER_NAME, tool: 'get_runbook', outcome });
      }
    },
  );

  server.tool(
    'post_incident_update',
    'Post a status update comment on a tracked incident issue',
    {
      issue_number: z.number().int().describe('GitHub issue number of the incident'),
      body: z.string().describe('Markdown update to post'),
    },
    async ({ issue_number, body }) => {
      const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'post_incident_update' });
      agentToolCalls.inc({ server: SERVER_NAME, tool: 'post_incident_update', agent: agentId });
      let outcome = 'success';
      auditLog({ action: 'incident_update_requested', agent: agentId, issue_number });
      try {
        if (!INCIDENT_REPO) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ posted: false, message: 'INCIDENT_REPO not configured.' }) }] };
        }
        const res = await ghFetch(`/repos/${INCIDENT_REPO}/issues/${issue_number}/comments`, {
          method: 'POST',
          body: JSON.stringify({ body }),
        });
        if (!res.ok) throw new Error(`GitHub API error ${res.status}: ${await res.text()}`);
        const comment = await res.json() as { id: number; html_url: string };
        auditLog({ action: 'incident_update_posted', agent: agentId, issue_number, comment_id: comment.id });
        return { content: [{ type: 'text' as const, text: JSON.stringify({ posted: true, comment_id: comment.id, url: comment.html_url }) }] };
      } catch (err) {
        outcome = 'error';
        throw err;
      } finally {
        end();
        toolCalls.inc({ server: SERVER_NAME, tool: 'post_incident_update', outcome });
      }
    },
  );

  server.tool(
    'send_notification',
    'Send a notification message to the platform Slack incidents channel',
    {
      message: z.string().describe('Notification text (markdown supported by Slack)'),
    },
    async ({ message }) => {
      const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'send_notification' });
      agentToolCalls.inc({ server: SERVER_NAME, tool: 'send_notification', agent: agentId });
      let outcome = 'success';
      auditLog({ action: 'notification_requested', agent: agentId });
      try {
        if (!SLACK_WEBHOOK_URL) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ sent: false, message: 'SLACK_WEBHOOK_URL not configured.' }) }] };
        }
        const res = await fetchWithTimeout(SLACK_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: message }),
        });
        if (!res.ok) throw new Error(`Slack webhook error ${res.status}: ${await res.text()}`);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ sent: true }) }] };
      } catch (err) {
        outcome = 'error';
        throw err;
      } finally {
        end();
        toolCalls.inc({ server: SERVER_NAME, tool: 'send_notification', outcome });
      }
    },
  );

  return server;
}
