import express, { Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import type { Counter } from 'prom-client';

export type PostFn = (agentName: string, message: string) => Promise<void>;
export type EventCounter = Counter<'source' | 'event_type' | 'agent' | 'outcome'>;

// ── Auth helpers ───────────────────────────────────────────────────────────

export function verifyGitHubSignature(req: Request, res: Response, secret?: string): boolean {
  const effectiveSecret = secret ?? '';
  if (!effectiveSecret) {
    res.status(503).json({ error: 'github webhook secret not configured' });
    return false;
  }
  const sig = (req.headers['x-hub-signature-256'] as string) ?? '';
  const raw: Buffer = (req as any).rawBody ?? Buffer.alloc(0);
  const expected = 'sha256=' + crypto
    .createHmac('sha256', effectiveSecret)
    .update(raw)
    .digest('hex');

  const sigBuf = Buffer.from(sig.padEnd(expected.length, '\0'));
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    res.status(401).json({ error: 'invalid signature' });
    return false;
  }
  return true;
}

export function verifyBearerToken(req: Request, res: Response, token?: string): boolean {
  const effectiveToken = token ?? '';
  if (!effectiveToken) return true;
  const auth = (req.headers['authorization'] as string) ?? '';
  if (auth !== `Bearer ${effectiveToken}`) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}

// ── Routing logic ──────────────────────────────────────────────────────────

export async function routeGitHub(
  event: string,
  payload: Record<string, unknown>,
  postFn: PostFn,
  counter?: EventCounter,
): Promise<void> {
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

    await postFn('qa-assistant', msg);
    counter?.inc({ source: 'github', event_type: 'pull_request', agent: 'qa-assistant', outcome: 'routed' });
    return;
  }

  if (event === 'push' && (payload.ref as string) === 'refs/heads/main') {
    const repo = (payload.repository as Record<string, unknown>)?.full_name ?? 'unknown';
    const commits = ((payload.commits as unknown[]) ?? []).length;
    const headMsg = (payload.head_commit as Record<string, unknown>)?.message ?? 'unknown';

    const msg = `${commits} commit(s) pushed to main in ${repo}. ` +
      `Latest commit: "${headMsg}". Check if any running deployments need attention or are out of sync.`;

    await postFn('idp-assistant', msg);
    counter?.inc({ source: 'github', event_type: 'push_main', agent: 'idp-assistant', outcome: 'routed' });
    return;
  }

  counter?.inc({ source: 'github', event_type: event, agent: 'none', outcome: 'ignored' });
}

export async function routeAlertManager(
  payload: Record<string, unknown>,
  postFn: PostFn,
  counter?: EventCounter,
): Promise<void> {
  const alerts = (payload.alerts as Record<string, unknown>[]) ?? [];
  const firing = alerts.filter(a => a.status === 'firing');

  if (firing.length === 0) {
    counter?.inc({ source: 'alertmanager', event_type: 'resolved', agent: 'none', outcome: 'ignored' });
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

    const isBudgetAlert = ['TeamBudgetWarning', 'TeamBudgetExceeded', 'TeamBudgetOverrun'].includes(name) || name.toLowerCase().includes('budget');
    const targetAgent = isBudgetAlert ? 'cost-agent' : 'idp-assistant';
    const team = labels.team ?? '';

    const msg = isBudgetAlert
      ? `Budget alert firing: "${name}" for team "${team}" (severity: ${severity}). ` +
        `${description ? `${description}. ` : ''}` +
        `Call get_team_spend and forecast_budget for team "${team}", then get_rightsizing_recommendations for their namespace.`
      : `Alert firing: "${name}" (severity: ${severity}) in namespace ${namespace}. ` +
        `${summary ? `Summary: ${summary}. ` : ''}` +
        `${description ? `Details: ${description}. ` : ''}` +
        `Investigate by checking recent deployments, service metrics, and pod status.`;

    await postFn(targetAgent, msg);
    counter?.inc({ source: 'alertmanager', event_type: 'firing', agent: targetAgent, outcome: 'routed' });
  }
}

export async function routeArgoCD(
  payload: Record<string, unknown>,
  postFn: PostFn,
  counter?: EventCounter,
): Promise<void> {
  const app = (payload.app as Record<string, unknown>) ?? payload;
  const appName = (app.metadata as Record<string, unknown>)?.name ?? payload.name ?? 'unknown';
  const status = (app.status as Record<string, unknown>) ?? {};
  const syncStatus = (status.sync as Record<string, string>)?.status ?? (payload.sync_status as string) ?? 'unknown';
  const healthStatus = (status.health as Record<string, string>)?.status ?? (payload.health_status as string) ?? 'unknown';

  if (syncStatus === 'OutOfSync' || healthStatus === 'Degraded') {
    const msg = `ArgoCD application "${appName}" requires attention. ` +
      `Sync status: ${syncStatus}. Health status: ${healthStatus}. ` +
      `Call get_app_health and get_app_diff to diagnose, then propose sync or rollback as appropriate.`;

    await postFn('release-agent', msg);
    counter?.inc({ source: 'argocd', event_type: 'app_degraded', agent: 'release-agent', outcome: 'routed' });
    return;
  }

  counter?.inc({ source: 'argocd', event_type: 'app_healthy', agent: 'none', outcome: 'ignored' });
}

// ── App factory ────────────────────────────────────────────────────────────

export interface AppOptions {
  githubSecret?: string;
  webhookToken?: string;
  postFn?: PostFn;
  counter?: EventCounter;
}

export function createApp(opts: AppOptions = {}): express.Application {
  const { githubSecret, webhookToken, postFn, counter } = opts;

  const defaultPostFn: PostFn = async () => {};
  const effectivePostFn = postFn ?? defaultPostFn;

  const app = express();

  app.use(express.json({
    verify: (req: any, _res, buf) => { req.rawBody = buf; },
    limit: '1mb',
  }));

  app.get('/healthz', (_req: Request, res: Response) => { res.json({ status: 'ok' }); });
  app.get('/ready', (_req: Request, res: Response) => { res.json({ status: 'ready' }); });

  // Each webhook fans out to a KAgent A2A call — rate-limit to blunt
  // denial-of-service from a flood of inbound webhook deliveries.
  const webhookLimiter = rateLimit({
    windowMs: 60_000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use('/webhook', webhookLimiter);

  app.post('/webhook/github', async (req: Request, res: Response) => {
    if (!verifyGitHubSignature(req, res, githubSecret)) return;
    const event = (req.headers['x-github-event'] as string) ?? 'unknown';
    res.json({ status: 'accepted' });
    try { await routeGitHub(event, req.body, effectivePostFn, counter); } catch (err) {
      console.error('[event-router] github routing error:', err);
    }
  });

  app.post('/webhook/alertmanager', async (req: Request, res: Response) => {
    if (!verifyBearerToken(req, res, webhookToken)) return;
    res.json({ status: 'accepted' });
    try { await routeAlertManager(req.body, effectivePostFn, counter); } catch (err) {
      console.error('[event-router] alertmanager routing error:', err);
    }
  });

  app.post('/webhook/argocd', async (req: Request, res: Response) => {
    if (!verifyBearerToken(req, res, webhookToken)) return;
    res.json({ status: 'accepted' });
    try { await routeArgoCD(req.body, effectivePostFn, counter); } catch (err) {
      console.error('[event-router] argocd routing error:', err);
    }
  });

  return app;
}
