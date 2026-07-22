import { collectDefaultMetrics, Counter, register } from 'prom-client';
import { createApp } from './router.js';
import type { Request, Response } from 'express';
import crypto from 'crypto';

const PORT = parseInt(process.env.PORT ?? '3004', 10);
const KAGENT_A2A_URL = process.env.KAGENT_A2A_URL ?? 'http://kagent-ui.kagent.svc.cluster.local:8080';
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET ?? '';
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN ?? '';
const HTTP_TIMEOUT_MS = parseInt(process.env.HTTP_TIMEOUT_MS ?? '5000', 10);

if (!GITHUB_WEBHOOK_SECRET) {
  console.warn('[event-router] WARNING: GITHUB_WEBHOOK_SECRET not set — /webhook/github will return 503');
}
if (!WEBHOOK_TOKEN) {
  console.warn('[event-router] WARNING: WEBHOOK_TOKEN not set — alertmanager/argocd endpoints are unauthenticated (acceptable for in-cluster only)');
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
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
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
  } finally {
    clearTimeout(timer);
  }
}

const app = createApp({
  githubSecret: GITHUB_WEBHOOK_SECRET,
  webhookToken: WEBHOOK_TOKEN,
  postFn: postToAgent,
  counter: eventsTotal,
});

app.get('/metrics', async (_req: Request, res: Response) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.listen(PORT, () => console.log(`[event-router] listening on :${PORT}`));
