import express, { Request, Response } from 'express';
import { collectDefaultMetrics, Counter, register } from 'prom-client';
import crypto from 'crypto';

const PORT = parseInt(process.env.PORT ?? '3004', 10);
const KAGENT_A2A_URL = process.env.KAGENT_A2A_URL ?? 'http://kagent-ui.kagent.svc.cluster.local:8080';
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET ?? '';
// Shared bearer token for AlertManager and ArgoCD webhook endpoints.
// Optional locally (in-cluster only), required in AWS (set via secret).
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

const app = express();

// Capture raw request bytes for HMAC verification before JSON parsing.
app.use(express.json({
  verify: (req: any, _res, buf) => { req.rawBody = buf; },
  limit: '1mb',
}));

app.get('/healthz', (_req: Request, res: Response) => { res.json({ status: 'ok' }); });
app.get('/ready', (_req: Request, res: Response) => { res.json({ status: 'ready' }); });
app.get('/metrics', async (_req: Request, res: Response) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// ── Auth helpers ───────────────────────────────────────────────────────────

function verifyGitHubSignature(req: Request, res: Response): boolean {
  if (!GITHUB_WEBHOOK_SECRET) {
    res.status(503).json({ error: 'github webhook secret not configured' });
    return false;
  }
  const sig = (req.headers['x-hub-signature-256'] as string) ?? '';
  const raw: Buffer = (req as any).rawBody ?? Buffer.alloc(0);
  const expected = 'sha256=' + crypto
    .createHmac('sha256', GITHUB_WEBHOOK_SECRET)
    .update(raw)
    .digest('hex');

  // Constant-time comparison — prevent timing attacks.
  const sigBuf = Buffer.from(sig.padEnd(expected.length, '\0'));
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    eventsTotal.inc({ source: 'github', event_type: 'unknown', agent: 'none', outcome: 'rejected' });
    res.status(401).json({ error: 'invalid signature' });
    return false;
  }
  return true;
}

function verifyBearerToken(req: Request, res: Response): boolean {
  if (!WEBHOOK_TOKEN) return true; // unauthenticated allowed locally (in-cluster callers only)
  const auth = (req.headers['authorization'] as string) ?? '';
  if (auth !== `Bearer ${WEBHOOK_TOKEN}`) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}

// ── GitHub ─────────────────────────────────────────────────────────────────
app.post('/webhook/github', async (req: Request, res: Response) => {
  if (!verifyGitHubSignature(req, res)) return;
  const event = (req.headers['x-github-event'] as string) ?? 'unknown';
  res.json({ status: 'accepted' });
  try { await routeGitHub(event, req.body); } catch (err) {
    console.error('[event-router] github routing error:', err);
  }
});

// ── AlertManager ───────────────────────────────────────────────────────────
app.post('/webhook/alertmanager', async (req: Request, res: Response) => {
  if (!verifyBearerToken(req, res)) return;
  res.json({ status: 'accepted' });
  try { await routeAlertManager(req.body); } catch (err) {
    console.error('[event-router] alertmanager routing error:', err);
  }
});

// ── ArgoCD ─────────────────────────────────────────────────────────────────
app.post('/webhook/argocd', async (req: Request, res: Response) => {
  if (!verifyBearerToken(req, res)) return;
  res.json({ status: 'accepted' });
  try { await routeArgoCD(req.body); } catch (err) {
    console.error('[event-router] argocd routing error:', err);
  }
});

// ── Routing logic ──────────────────────────────────────────────────────────

async function routeGitHub(event: string, payload: Record<string, unknown>): Promise<void> {
  const action = (payload.action as string) ?? '';

  if (event === 'pull_request' && ['opened', 'synchronize', 'reopened'].includes(action)) {
    const pr = (payload.pull_request as Record<string, unknown>) ?? {};
    const repo = (payload.repository as Record<string, unknown>)?.full_name ?? 'unknown';
    const prNum = pr.number ?? '?';
    const title = pr.title ?? '';
    const author = (pr.user as Record<string, unknown>)?.login ?? 'unknown';
    const base = (pr.base as Record<string, unknown>)?.ref ?? 'main';
    const changedFiles = pr.changed_files ?? 'unknown';

    const msg = `PR #${prNum} was ${action} in ${repo} by ${author}. ` +
      `Title: "${title}". Target branch: ${base}. Files changed: ${changedFiles}. ` +
      `Check whether this PR has adequate test coverage. If key test suites (unit, integration, contract, E2E) ` +
      `are missing, suggest which templates to scaffold using the available test suite catalog.`;

    await postToAgent('qa-assistant', msg);
    eventsTotal.inc({ source: 'github', event_type: 'pull_request', agent: 'qa-assistant', outcome: 'routed' });
    return;
  }

  if (event === 'push' && (payload.ref as string) === 'refs/heads/main') {
    const repo = (payload.repository as Record<string, unknown>)?.full_name ?? 'unknown';
    const commits = ((payload.commits as unknown[]) ?? []).length;
    const headMsg = (payload.head_commit as Record<string, unknown>)?.message ?? 'unknown';

    const msg = `${commits} commit(s) pushed to main in ${repo}. ` +
      `Latest commit: "${headMsg}". Check if any running deployments need attention or are out of sync.`;

    await postToAgent('idp-assistant', msg);
    eventsTotal.inc({ source: 'github', event_type: 'push_main', agent: 'idp-assistant', outcome: 'routed' });
    return;
  }

  eventsTotal.inc({ source: 'github', event_type: event, agent: 'none', outcome: 'ignored' });
}

async function routeAlertManager(payload: Record<string, unknown>): Promise<void> {
  const alerts = (payload.alerts as Record<string, unknown>[]) ?? [];
  const firing = alerts.filter(a => a.status === 'firing');

  if (firing.length === 0) {
    eventsTotal.inc({ source: 'alertmanager', event_type: 'resolved', agent: 'none', outcome: 'ignored' });
    return;
  }

  for (const alert of firing) {
    const labels = (alert.labels as Record<string, string>) ?? {};
    const annotations = (alert.annotations as Record<string, string>) ?? {};
    const name = labels.alertname ?? 'unknown';
    const severity = labels.severity ?? 'unknown';
    const namespace = labels.namespace ?? labels.instance ?? 'unknown';
    const summary = annotations.summary ?? '';
    const description = annotations.description ?? '';

    const msg = `Alert firing: "${name}" (severity: ${severity}) in namespace ${namespace}. ` +
      `${summary ? `Summary: ${summary}. ` : ''}` +
      `${description ? `Details: ${description}. ` : ''}` +
      `Investigate by checking recent deployments, service metrics, and pod status.`;

    await postToAgent('idp-assistant', msg);
    eventsTotal.inc({ source: 'alertmanager', event_type: 'firing', agent: 'idp-assistant', outcome: 'routed' });
  }
}

async function routeArgoCD(payload: Record<string, unknown>): Promise<void> {
  const app = (payload.app as Record<string, unknown>) ?? payload;
  const appName = (app.metadata as Record<string, unknown>)?.name ?? payload.name ?? 'unknown';
  const status = (app.status as Record<string, unknown>) ?? {};
  const syncStatus = (status.sync as Record<string, string>)?.status ?? (payload.sync_status as string) ?? 'unknown';
  const healthStatus = (status.health as Record<string, string>)?.status ?? (payload.health_status as string) ?? 'unknown';

  if (syncStatus === 'OutOfSync' || healthStatus === 'Degraded') {
    const msg = `ArgoCD application "${appName}" requires attention. ` +
      `Sync status: ${syncStatus}. Health status: ${healthStatus}. ` +
      `Check deployment status and determine if a sync or rollback is needed.`;

    await postToAgent('idp-assistant', msg);
    eventsTotal.inc({ source: 'argocd', event_type: 'app_degraded', agent: 'idp-assistant', outcome: 'routed' });
    return;
  }

  eventsTotal.inc({ source: 'argocd', event_type: 'app_healthy', agent: 'none', outcome: 'ignored' });
}

// ── A2A dispatch ───────────────────────────────────────────────────────────

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

app.listen(PORT, () => console.log(`[event-router] listening on :${PORT}`));
