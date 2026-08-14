import { collectDefaultMetrics, Counter, register } from 'prom-client';
import { createApp } from './router.js';
import type { Request, Response } from 'express';
import crypto from 'crypto';

const PORT = parseInt(process.env.PORT ?? '3004', 10);
const KAGENT_A2A_URL = process.env.KAGENT_A2A_URL ?? 'http://kagent-ui.kagent.svc.cluster.local:8080';
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET ?? '';
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN ?? '';
const HTTP_TIMEOUT_MS = parseInt(process.env.HTTP_TIMEOUT_MS ?? '5000', 10);
// Agent dispatch gets its own, much longer budget. A KAgent A2A call is an LLM
// turn — several, once the agent starts calling MCP tools.
//
// Measured against the live incident-agent rather than guessed:
//   - trivial prompt, no tool calls ......  4.3s
//   - real triage prompt, multi-tool .... 42.9s
//
// The original 5s shared HTTP_TIMEOUT_MS aborted even the trivial case by a
// 700ms margin. 60s was then tried and still timed out, because KAgent's
// message/send is synchronous and concurrent alerts SERIALISE: two alerts 35s
// apart put the second past the limit while the first was still thinking.
//
// 180s covers a multi-tool turn plus a couple of queued ones. It is not a
// substitute for the real fix, which is to stop awaiting the whole agent turn
// here — the router's job is to dispatch, not to wait for an LLM to finish.
//
// This mattered more than a slow call: the incident issue is created *before*
// dispatch, so the pipeline still produced its most visible artefact while the
// agent half silently never ran.
const AGENT_TIMEOUT_MS = parseInt(process.env.AGENT_TIMEOUT_MS ?? '180000', 10);
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? '';
const INCIDENT_REPO = process.env.INCIDENT_REPO ?? '';
// Which alert severities get a tracked GitHub issue. Critical only by default:
// filing for warnings on a noisy cluster buries the repo, and that is a decision
// each operator should make rather than inherit.
const INCIDENT_SEVERITIES = (process.env.INCIDENT_SEVERITIES ?? 'critical')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);
// Optional. Without it incidents are still filed, just not cross-linked to the
// PagerDuty incident that paged the on-call engineer.
const PAGERDUTY_TOKEN = process.env.PAGERDUTY_TOKEN ?? '';
const PAGERDUTY_SERVICE_IDS = (process.env.PAGERDUTY_SERVICE_IDS ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

if (!GITHUB_WEBHOOK_SECRET) {
  console.warn('[event-router] WARNING: GITHUB_WEBHOOK_SECRET not set — /webhook/github will return 503');
}
if (!WEBHOOK_TOKEN) {
  console.warn('[event-router] WARNING: WEBHOOK_TOKEN not set — alertmanager/argocd endpoints are unauthenticated (acceptable for in-cluster only)');
}
if (!GITHUB_TOKEN || !INCIDENT_REPO) {
  console.warn('[event-router] GITHUB_TOKEN/INCIDENT_REPO not set — automatic incident-issue creation on critical alerts is disabled');
}

collectDefaultMetrics();

const eventsTotal = new Counter({
  name: 'event_router_events_total',
  help: 'Total webhook events received by source, type, and routing outcome',
  labelNames: ['source', 'event_type', 'agent', 'outcome'] as const,
});

async function postToAgent(agentName: string, message: string): Promise<void> {
  const url = `${KAGENT_A2A_URL}/a2a/kagent/${agentName}`;
  const messageId = crypto.randomUUID();

  console.log('[ROUTE] ' + JSON.stringify({
    ts: new Date().toISOString(),
    agent: agentName,
    messageId,
    preview: message.slice(0, 100),
  }));

  const body = {
    jsonrpc: '2.0',
    method: 'message/send',
    params: {
      message: {
        messageId,
        role: 'user',
        parts: [{ kind: 'text', text: message }],
      },
    },
    id: 1,
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), AGENT_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-ID': 'event-router' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      console.error(`[event-router] A2A POST to ${agentName} returned HTTP ${resp.status}`);
    }
  } catch (err) {
    // An abort surfaced as a bare DOMException from undici, which says nothing
    // about which agent timed out or what to change.
    if ((err as Error)?.name === 'AbortError') {
      console.error(
        `[event-router] A2A POST to ${agentName} timed out after ${AGENT_TIMEOUT_MS}ms. ` +
          'The incident record was still created; only the agent triage was skipped. ' +
          'A real multi-tool turn measures ~43s, and concurrent alerts serialise — ' +
          'raise AGENT_TIMEOUT_MS if alerts arrive in bursts.',
      );
      return;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const app = createApp({
  githubSecret: GITHUB_WEBHOOK_SECRET,
  webhookToken: WEBHOOK_TOKEN,
  postFn: postToAgent,
  counter: eventsTotal,
  github: GITHUB_TOKEN && INCIDENT_REPO ? { token: GITHUB_TOKEN, repo: INCIDENT_REPO } : undefined,
  severities: INCIDENT_SEVERITIES,
  pagerduty:
    PAGERDUTY_TOKEN && PAGERDUTY_SERVICE_IDS.length
      ? { token: PAGERDUTY_TOKEN, serviceIds: PAGERDUTY_SERVICE_IDS }
      : undefined,
});

app.get('/metrics', async (_req: Request, res: Response) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.listen(PORT, () => console.log(`[event-router] listening on :${PORT}`));
