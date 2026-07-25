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

// ── Incident record automation ─────────────────────────────────────────────
//
// Critical alerts already page via PagerDuty (see observability/alertmanager);
// this layer additionally opens a tracked GitHub issue on firing and closes
// the loop with a resolution comment when the alert clears, so incidents have
// a record beyond the page itself. Seeded fields mirror docs/postmortem-template.md;
// the rest of that template is filled in by a human during the 48h follow-up.

export interface OpenIncident {
  issueNumber: number;
  alertname: string;
  startsAt: string;
}

export interface GitHubIncidentConfig {
  token: string;
  repo: string; // "owner/repo"
  fetchImpl?: typeof fetch; // injectable for tests
}

function githubHeaders(token: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
  };
}

function incidentId(startsAt: string): string {
  const compact = startsAt.replace(/[^0-9]/g, '').slice(0, 14) || Date.now().toString();
  return `INC-${compact}`;
}

export async function createIncidentIssue(
  alert: Record<string, unknown>,
  config: GitHubIncidentConfig,
): Promise<number | null> {
  const labels = (alert.labels as Record<string, string>) ?? {};
  const annotations = (alert.annotations as Record<string, string>) ?? {};
  const name = labels.alertname ?? 'unknown';
  const severity = labels.severity ?? 'unknown';
  const namespace = labels.namespace ?? labels.instance ?? 'unknown';
  const service = labels.service ?? namespace;
  const startsAt = (alert.startsAt as string) ?? new Date().toISOString();
  const id = incidentId(startsAt);

  const body = [
    '## Incident Summary',
    '',
    '| Field | Value |',
    '|-------|-------|',
    `| **Incident ID** | ${id} |`,
    `| **Severity** | ${severity} |`,
    `| **Service(s) affected** | ${service} |`,
    `| **Start time** | ${startsAt} |`,
    `| **Alert** | \`${name}\` |`,
    '',
    annotations.summary ? `**Summary:** ${annotations.summary}` : '',
    annotations.description ? `**Details:** ${annotations.description}` : '',
    annotations.runbook_url ? `**Runbook:** ${annotations.runbook_url}` : '',
    '',
    'This issue was auto-created by `agent-event-router` when the alert started firing — ' +
      'it tracks the incident record. Complete the full write-up in ' +
      '`docs/postmortem-template.md` within 48 hours of resolution.',
  ].filter(line => line !== '').join('\n');

  const fetchImpl = config.fetchImpl ?? fetch;
  const res = await fetchImpl(`https://api.github.com/repos/${config.repo}/issues`, {
    method: 'POST',
    headers: githubHeaders(config.token),
    body: JSON.stringify({
      title: `[INCIDENT] ${name} — ${service} (${id})`,
      body,
      labels: ['incident', 'incident:open', `severity:${severity}`],
    }),
  });

  if (!res.ok) {
    console.error(`[event-router] failed to create incident issue: HTTP ${res.status}`);
    return null;
  }
  const json = (await res.json()) as { number: number };
  return json.number;
}

export async function resolveIncidentIssue(
  record: OpenIncident,
  alert: Record<string, unknown>,
  config: GitHubIncidentConfig,
): Promise<void> {
  const endsAt = (alert.endsAt as string) ?? new Date().toISOString();
  const durationMs = Date.parse(endsAt) - Date.parse(record.startsAt);
  const durationMin = Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs / 60000)) : null;
  const fetchImpl = config.fetchImpl ?? fetch;

  await fetchImpl(`https://api.github.com/repos/${config.repo}/issues/${record.issueNumber}/comments`, {
    method: 'POST',
    headers: githubHeaders(config.token),
    body: JSON.stringify({
      body: `Alert \`${record.alertname}\` resolved at ${endsAt}` +
        (durationMin !== null ? ` (${durationMin} min after it started firing).` : '.') +
        ' Complete the postmortem within 48 hours using `docs/postmortem-template.md`.',
    }),
  });

  await fetchImpl(`https://api.github.com/repos/${config.repo}/issues/${record.issueNumber}/labels`, {
    method: 'POST',
    headers: githubHeaders(config.token),
    body: JSON.stringify({ labels: ['incident:needs-postmortem'] }),
  });

  await fetchImpl(
    `https://api.github.com/repos/${config.repo}/issues/${record.issueNumber}/labels/incident%3Aopen`,
    { method: 'DELETE', headers: githubHeaders(config.token) },
  );
}

// ── routeAlertManager ───────────────────────────────────────────────────────

export async function routeAlertManager(
  payload: Record<string, unknown>,
  postFn: PostFn,
  counter?: EventCounter,
  github?: GitHubIncidentConfig,
  openIncidents?: Map<string, OpenIncident>,
): Promise<void> {
  const alerts = (payload.alerts as Record<string, unknown>[]) ?? [];

  for (const alert of alerts) {
    const labels = (alert.labels as Record<string, string>) ?? {};
    const annotations = (alert.annotations as Record<string, string>) ?? {};
    const status = (alert.status as string) ?? 'firing';
    const name = labels.alertname ?? 'unknown';
    const severity = labels.severity ?? 'unknown';
    const namespace = labels.namespace ?? labels.instance ?? 'unknown';
    const fingerprint = (alert.fingerprint as string) ?? `${name}:${namespace}`;

    if (status === 'resolved') {
      const record = openIncidents?.get(fingerprint);
      if (github && openIncidents && record) {
        openIncidents.delete(fingerprint);
        try {
          await resolveIncidentIssue(record, alert, github);
          counter?.inc({ source: 'alertmanager', event_type: 'incident_resolved', agent: 'github', outcome: 'routed' });
        } catch (err) {
          console.error('[event-router] failed to resolve incident issue:', err);
        }
      } else {
        counter?.inc({ source: 'alertmanager', event_type: 'resolved', agent: 'none', outcome: 'ignored' });
      }
      continue;
    }

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

    if (github && openIncidents && severity === 'critical' && !openIncidents.has(fingerprint)) {
      try {
        const issueNumber = await createIncidentIssue(alert, github);
        if (issueNumber) {
          openIncidents.set(fingerprint, {
            issueNumber,
            alertname: name,
            startsAt: (alert.startsAt as string) ?? new Date().toISOString(),
          });
          counter?.inc({ source: 'alertmanager', event_type: 'incident_created', agent: 'github', outcome: 'routed' });
        }
      } catch (err) {
        console.error('[event-router] failed to create incident issue:', err);
      }
    }
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
  github?: GitHubIncidentConfig;
}

export function createApp(opts: AppOptions = {}): express.Application {
  const { githubSecret, webhookToken, postFn, counter, github } = opts;

  const defaultPostFn: PostFn = async () => {};
  const effectivePostFn = postFn ?? defaultPostFn;
  const openIncidents = new Map<string, OpenIncident>();

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
    try { await routeAlertManager(req.body, effectivePostFn, counter, github, openIncidents); } catch (err) {
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
