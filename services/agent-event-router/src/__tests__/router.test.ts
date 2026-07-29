import crypto from 'crypto';
import request from 'supertest';
import express from 'express';
import rateLimit from 'express-rate-limit';
import {
  verifyGitHubSignature,
  verifyBearerToken,
  routeGitHub,
  routeAlertManager,
  routeArgoCD,
  createApp,
  createIncidentIssue,
  resolveIncidentIssue,
  type GitHubIncidentConfig,
  type OpenIncident,
} from '../router';

// ── Helpers ────────────────────────────────────────────────────────────────

// Mirrors the production webhookLimiter in router.ts so these standalone
// test apps match the rate-limited shape of the real routes.
function testRateLimiter() {
  return rateLimit({ windowMs: 60_000, max: 1000, standardHeaders: true, legacyHeaders: false });
}

function makeSignedRequest(
  app: express.Application,
  body: Record<string, unknown>,
  secret: string,
  event = 'push',
) {
  const rawBody = JSON.stringify(body);
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return request(app)
    .post('/webhook/github')
    .set('Content-Type', 'application/json')
    .set('x-hub-signature-256', sig)
    .set('x-github-event', event)
    .send(rawBody);
}

// ── verifyGitHubSignature ──────────────────────────────────────────────────

describe('verifyGitHubSignature', () => {
  let mockRes: any;

  beforeEach(() => {
    jest.resetAllMocks();
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
  });

  it('returns false and sends 503 when secret is not configured', () => {
    const app = express();
    app.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf; } }));
    app.use(testRateLimiter());
    app.post('/test', (req, res) => {
      const result = verifyGitHubSignature(req, res, '');
      if (result) res.json({ ok: true });
    });

    return request(app)
      .post('/test')
      .send({})
      .expect(503)
      .expect((r) => {
        expect(r.body.error).toMatch(/not configured/);
      });
  });

  it('returns false and sends 401 when signature is wrong', () => {
    const app = express();
    app.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf; } }));
    app.use(testRateLimiter());
    app.post('/test', (req, res) => {
      const result = verifyGitHubSignature(req, res, 'my-secret');
      if (result) res.json({ ok: true });
    });

    return request(app)
      .post('/test')
      .set('x-hub-signature-256', 'sha256=badhash')
      .send({ foo: 'bar' })
      .expect(401)
      .expect((r) => {
        expect(r.body.error).toMatch(/invalid signature/);
      });
  });

  it('returns true when signature is valid', () => {
    const secret = 'test-secret';
    const body = { foo: 'bar' };
    const rawBody = JSON.stringify(body);
    const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

    const app = express();
    app.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf; } }));
    app.use(testRateLimiter());
    app.post('/test', (req, res) => {
      const result = verifyGitHubSignature(req, res, secret);
      if (result) res.json({ ok: true });
    });

    return request(app)
      .post('/test')
      .set('Content-Type', 'application/json')
      .set('x-hub-signature-256', sig)
      .send(rawBody)
      .expect(200)
      .expect((r) => {
        expect(r.body.ok).toBe(true);
      });
  });
});

// ── verifyBearerToken ──────────────────────────────────────────────────────

describe('verifyBearerToken', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('returns true (passes) when no token configured', () => {
    const app = express();
    app.use(express.json());
    app.use(testRateLimiter());
    app.post('/test', (req, res) => {
      const result = verifyBearerToken(req, res, '');
      res.json({ passed: result });
    });

    return request(app)
      .post('/test')
      .send({})
      .expect(200)
      .expect((r) => {
        expect(r.body.passed).toBe(true);
      });
  });

  it('returns false and sends 401 when token is wrong', () => {
    const app = express();
    app.use(express.json());
    app.use(testRateLimiter());
    app.post('/test', (req, res) => {
      const result = verifyBearerToken(req, res, 'correct-token');
      if (result) res.json({ passed: true });
    });

    return request(app)
      .post('/test')
      .set('Authorization', 'Bearer wrong-token')
      .send({})
      .expect(401)
      .expect((r) => {
        expect(r.body.error).toMatch(/unauthorized/);
      });
  });

  it('returns true when correct Bearer token provided', () => {
    const app = express();
    app.use(express.json());
    app.use(testRateLimiter());
    app.post('/test', (req, res) => {
      const result = verifyBearerToken(req, res, 'my-token');
      res.json({ passed: result });
    });

    return request(app)
      .post('/test')
      .set('Authorization', 'Bearer my-token')
      .send({})
      .expect(200)
      .expect((r) => {
        expect(r.body.passed).toBe(true);
      });
  });
});

// ── routeGitHub ────────────────────────────────────────────────────────────

describe('routeGitHub', () => {
  let postFn: jest.Mock;

  beforeEach(() => {
    jest.resetAllMocks();
    postFn = jest.fn().mockResolvedValue(undefined);
  });

  it('routes PR opened to qa-assistant with PR info', async () => {
    const payload = {
      action: 'opened',
      pull_request: {
        number: 42,
        title: 'Add feature',
        user: { login: 'alice' },
        base: { ref: 'main' },
        changed_files: 5,
      },
      repository: { full_name: 'org/repo' },
    };

    await routeGitHub('pull_request', payload, postFn);

    expect(postFn).toHaveBeenCalledTimes(1);
    const [agent, msg] = postFn.mock.calls[0];
    expect(agent).toBe('qa-assistant');
    expect(msg).toContain('PR #42');
    expect(msg).toContain('opened');
    expect(msg).toContain('org/repo');
    expect(msg).toContain('alice');
  });

  it('routes PR synchronize to qa-assistant', async () => {
    const payload = {
      action: 'synchronize',
      pull_request: {
        number: 10,
        title: 'Fix bug',
        user: { login: 'bob' },
        base: { ref: 'develop' },
        changed_files: 2,
      },
      repository: { full_name: 'org/repo' },
    };

    await routeGitHub('pull_request', payload, postFn);

    expect(postFn).toHaveBeenCalledTimes(1);
    const [agent, msg] = postFn.mock.calls[0];
    expect(agent).toBe('qa-assistant');
    expect(msg).toContain('synchronize');
  });

  it('routes push to refs/heads/main to idp-assistant', async () => {
    const payload = {
      ref: 'refs/heads/main',
      commits: [{}, {}],
      head_commit: { message: 'chore: update deps' },
      repository: { full_name: 'org/repo' },
    };

    await routeGitHub('push', payload, postFn);

    expect(postFn).toHaveBeenCalledTimes(1);
    const [agent, msg] = postFn.mock.calls[0];
    expect(agent).toBe('idp-assistant');
    expect(msg).toContain('2 commit(s)');
    expect(msg).toContain('chore: update deps');
  });

  it('does NOT call postFn for push to non-main branch', async () => {
    const payload = {
      ref: 'refs/heads/feature/my-feature',
      commits: [{}],
      head_commit: { message: 'wip' },
      repository: { full_name: 'org/repo' },
    };

    await routeGitHub('push', payload, postFn);

    expect(postFn).not.toHaveBeenCalled();
  });

  it('does NOT call postFn for unknown event', async () => {
    await routeGitHub('star', { action: 'created' }, postFn);

    expect(postFn).not.toHaveBeenCalled();
  });
});

// ── routeAlertManager ──────────────────────────────────────────────────────

describe('routeAlertManager', () => {
  let postFn: jest.Mock;

  beforeEach(() => {
    jest.resetAllMocks();
    postFn = jest.fn().mockResolvedValue(undefined);
  });

  it('makes no call when alerts array is empty', async () => {
    await routeAlertManager({ alerts: [] }, postFn);
    expect(postFn).not.toHaveBeenCalled();
  });

  it('makes no call when all alerts are resolved', async () => {
    const payload = {
      alerts: [
        { status: 'resolved', labels: { alertname: 'SomeAlert' }, annotations: {} },
        { status: 'resolved', labels: { alertname: 'AnotherAlert' }, annotations: {} },
      ],
    };
    await routeAlertManager(payload, postFn);
    expect(postFn).not.toHaveBeenCalled();
  });

  it('routes firing non-budget, non-critical alert to idp-assistant', async () => {
    const payload = {
      alerts: [
        {
          status: 'firing',
          labels: { alertname: 'PodCrashLooping', severity: 'warning', namespace: 'production' },
          annotations: { summary: 'Pod is crash looping', description: 'Check logs' },
        },
      ],
    };

    await routeAlertManager(payload, postFn);

    expect(postFn).toHaveBeenCalledTimes(1);
    const [agent, msg] = postFn.mock.calls[0];
    expect(agent).toBe('idp-assistant');
    expect(msg).toContain('PodCrashLooping');
    expect(msg).toContain('warning');
    expect(msg).toContain('production');
  });

  it('routes firing non-budget critical alert to incident-agent', async () => {
    const payload = {
      alerts: [
        {
          status: 'firing',
          labels: { alertname: 'PodCrashLooping', severity: 'critical', namespace: 'production' },
          annotations: { summary: 'Pod is crash looping', description: 'Check logs' },
        },
      ],
    };

    await routeAlertManager(payload, postFn);

    expect(postFn).toHaveBeenCalledTimes(1);
    const [agent, msg] = postFn.mock.calls[0];
    expect(agent).toBe('incident-agent');
    expect(msg).toContain('PodCrashLooping');
    expect(msg).toContain('critical');
    expect(msg).toContain('production');
  });

  it('routes TeamBudgetWarning alert to cost-agent', async () => {
    const payload = {
      alerts: [
        {
          status: 'firing',
          labels: { alertname: 'TeamBudgetWarning', severity: 'warning', team: 'platform' },
          annotations: { description: 'Platform team is over budget' },
        },
      ],
    };

    await routeAlertManager(payload, postFn);

    expect(postFn).toHaveBeenCalledTimes(1);
    const [agent, msg] = postFn.mock.calls[0];
    expect(agent).toBe('cost-agent');
    expect(msg).toContain('TeamBudgetWarning');
    expect(msg).toContain('platform');
  });

  it('routes alert with "budget" in the name to cost-agent', async () => {
    const payload = {
      alerts: [
        {
          status: 'firing',
          labels: { alertname: 'monthly-budget-exceeded', severity: 'critical', team: 'infra' },
          annotations: {},
        },
      ],
    };

    await routeAlertManager(payload, postFn);

    expect(postFn).toHaveBeenCalledTimes(1);
    const [agent] = postFn.mock.calls[0];
    expect(agent).toBe('cost-agent');
  });

  it('calls postFn for each firing alert in a batch', async () => {
    const payload = {
      alerts: [
        {
          status: 'firing',
          labels: { alertname: 'HighCPU', severity: 'warning', namespace: 'ns1' },
          annotations: {},
        },
        {
          status: 'resolved',
          labels: { alertname: 'HighMemory', severity: 'warning' },
          annotations: {},
        },
        {
          status: 'firing',
          labels: { alertname: 'DiskFull', severity: 'critical', namespace: 'ns2' },
          annotations: {},
        },
      ],
    };

    await routeAlertManager(payload, postFn);

    expect(postFn).toHaveBeenCalledTimes(2);
    expect(postFn.mock.calls[0][0]).toBe('idp-assistant');
    expect(postFn.mock.calls[1][0]).toBe('incident-agent');
  });

  it('includes the tracked issue number in the incident-agent message when one was created', async () => {
    const fetchImpl = mockFetch([{ ok: true, status: 201, json: { number: 77 } }]);
    const github: GitHubIncidentConfig = { token: 't', repo: 'org/repo', fetchImpl: fetchImpl as unknown as typeof fetch };
    const openIncidents = new Map<string, OpenIncident>();
    const payload = {
      alerts: [
        {
          status: 'firing',
          labels: { alertname: 'DiskFull', severity: 'critical', namespace: 'production' },
          annotations: {},
          fingerprint: 'fp-issue-ref',
        },
      ],
    };

    await routeAlertManager(payload, postFn, undefined, github, openIncidents);

    expect(postFn).toHaveBeenCalledTimes(1);
    const [agent, msg] = postFn.mock.calls[0];
    expect(agent).toBe('incident-agent');
    expect(msg).toContain('incident issue #77');
  });
});

// ── incident record automation ──────────────────────────────────────────────

function mockFetch(responses: Array<{ ok: boolean; status?: number; json?: unknown }>) {
  let call = 0;
  return jest.fn(async (_url: string, _init?: RequestInit) => {
    const r = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      json: async () => r.json ?? {},
    } as unknown as Response;
  });
}

describe('createIncidentIssue', () => {
  it('POSTs to the GitHub issues endpoint and returns the issue number', async () => {
    const fetchImpl = mockFetch([{ ok: true, json: { number: 42 } }]);
    const config: GitHubIncidentConfig = { token: 'gh-token', repo: 'org/repo', fetchImpl: fetchImpl as unknown as typeof fetch };

    const alert = {
      status: 'firing',
      startsAt: '2026-07-25T10:00:00Z',
      labels: { alertname: 'PodCrashLooping', severity: 'critical', namespace: 'production' },
      annotations: { summary: 'Pod is crash looping', runbook_url: 'https://runbooks/x' },
    };

    const issueNumber = await createIncidentIssue(alert, config);

    expect(issueNumber).toBe(42);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/org/repo/issues');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.title).toContain('PodCrashLooping');
    expect(body.title).toContain('production');
    expect(body.labels).toEqual(expect.arrayContaining(['incident', 'incident:open', 'severity:critical']));
    expect(body.body).toContain('Pod is crash looping');
    expect(body.body).toContain('docs/postmortem-template.md');
  });

  it('returns null when the GitHub API call fails', async () => {
    const fetchImpl = mockFetch([{ ok: false, status: 403 }]);
    const config: GitHubIncidentConfig = { token: 'gh-token', repo: 'org/repo', fetchImpl: fetchImpl as unknown as typeof fetch };

    const issueNumber = await createIncidentIssue(
      { status: 'firing', labels: { alertname: 'X', severity: 'critical' }, annotations: {} },
      config,
    );

    expect(issueNumber).toBeNull();
  });
});

describe('resolveIncidentIssue', () => {
  it('posts a resolution comment and swaps the incident:open label', async () => {
    const fetchImpl = mockFetch([{ ok: true }, { ok: true }, { ok: true }]);
    const config: GitHubIncidentConfig = { token: 'gh-token', repo: 'org/repo', fetchImpl: fetchImpl as unknown as typeof fetch };
    const record: OpenIncident = { issueNumber: 7, alertname: 'PodCrashLooping', startsAt: '2026-07-25T10:00:00Z' };

    await resolveIncidentIssue(record, { endsAt: '2026-07-25T10:30:00Z' }, config);

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const [commentUrl, commentInit] = fetchImpl.mock.calls[0];
    expect(commentUrl).toBe('https://api.github.com/repos/org/repo/issues/7/comments');
    const commentBody = JSON.parse((commentInit as RequestInit).body as string);
    expect(commentBody.body).toContain('30 min');

    const [labelUrl] = fetchImpl.mock.calls[1];
    expect(labelUrl).toBe('https://api.github.com/repos/org/repo/issues/7/labels');

    const [deleteUrl, deleteInit] = fetchImpl.mock.calls[2];
    expect(deleteUrl).toBe('https://api.github.com/repos/org/repo/issues/7/labels/incident%3Aopen');
    expect((deleteInit as RequestInit).method).toBe('DELETE');
  });
});

describe('routeAlertManager incident tracking', () => {
  let postFn: jest.Mock;
  let github: GitHubIncidentConfig;
  let fetchImpl: jest.Mock;
  let openIncidents: Map<string, OpenIncident>;

  beforeEach(() => {
    jest.resetAllMocks();
    postFn = jest.fn().mockResolvedValue(undefined);
    fetchImpl = mockFetch([{ ok: true, json: { number: 99 } }]);
    github = { token: 'gh-token', repo: 'org/repo', fetchImpl: fetchImpl as unknown as typeof fetch };
    openIncidents = new Map();
  });

  it('creates an incident issue for a firing critical alert', async () => {
    const payload = {
      alerts: [
        {
          status: 'firing',
          fingerprint: 'fp1',
          startsAt: '2026-07-25T10:00:00Z',
          labels: { alertname: 'DiskFull', severity: 'critical', namespace: 'production' },
          annotations: {},
        },
      ],
    };

    await routeAlertManager(payload, postFn, undefined, github, openIncidents);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(openIncidents.get('fp1')).toEqual({ issueNumber: 99, alertname: 'DiskFull', startsAt: '2026-07-25T10:00:00Z' });
  });

  it('does not create a second issue for a repeat firing notification (same fingerprint)', async () => {
    openIncidents.set('fp1', { issueNumber: 99, alertname: 'DiskFull', startsAt: '2026-07-25T10:00:00Z' });
    const payload = {
      alerts: [
        {
          status: 'firing',
          fingerprint: 'fp1',
          labels: { alertname: 'DiskFull', severity: 'critical', namespace: 'production' },
          annotations: {},
        },
      ],
    };

    await routeAlertManager(payload, postFn, undefined, github, openIncidents);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not open an incident for a non-critical (warning) alert', async () => {
    const payload = {
      alerts: [
        {
          status: 'firing',
          fingerprint: 'fp2',
          labels: { alertname: 'HighCPU', severity: 'warning', namespace: 'production' },
          annotations: {},
        },
      ],
    };

    await routeAlertManager(payload, postFn, undefined, github, openIncidents);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(openIncidents.size).toBe(0);
  });

  it('resolves a tracked incident and removes it from the open map', async () => {
    openIncidents.set('fp1', { issueNumber: 99, alertname: 'DiskFull', startsAt: '2026-07-25T10:00:00Z' });
    fetchImpl = mockFetch([{ ok: true }, { ok: true }, { ok: true }]);
    github = { token: 'gh-token', repo: 'org/repo', fetchImpl: fetchImpl as unknown as typeof fetch };

    const payload = {
      alerts: [
        {
          status: 'resolved',
          fingerprint: 'fp1',
          endsAt: '2026-07-25T10:15:00Z',
          labels: { alertname: 'DiskFull', severity: 'critical', namespace: 'production' },
          annotations: {},
        },
      ],
    };

    await routeAlertManager(payload, postFn, undefined, github, openIncidents);

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(openIncidents.has('fp1')).toBe(false);
    expect(postFn).not.toHaveBeenCalled();
  });

  it('does nothing incident-related when no github config is provided (existing behavior preserved)', async () => {
    const payload = {
      alerts: [
        {
          status: 'firing',
          fingerprint: 'fp3',
          labels: { alertname: 'DiskFull', severity: 'critical', namespace: 'production' },
          annotations: {},
        },
      ],
    };

    await routeAlertManager(payload, postFn);

    expect(postFn).toHaveBeenCalledTimes(1);
  });
});

// ── routeArgoCD ────────────────────────────────────────────────────────────

describe('routeArgoCD', () => {
  let postFn: jest.Mock;

  beforeEach(() => {
    jest.resetAllMocks();
    postFn = jest.fn().mockResolvedValue(undefined);
  });

  it('routes OutOfSync app to release-agent', async () => {
    const payload = {
      app: {
        metadata: { name: 'my-app' },
        status: {
          sync: { status: 'OutOfSync' },
          health: { status: 'Healthy' },
        },
      },
    };

    await routeArgoCD(payload, postFn);

    expect(postFn).toHaveBeenCalledTimes(1);
    const [agent, msg] = postFn.mock.calls[0];
    expect(agent).toBe('release-agent');
    expect(msg).toContain('my-app');
    expect(msg).toContain('OutOfSync');
  });

  it('routes Degraded health to release-agent', async () => {
    const payload = {
      app: {
        metadata: { name: 'broken-app' },
        status: {
          sync: { status: 'Synced' },
          health: { status: 'Degraded' },
        },
      },
    };

    await routeArgoCD(payload, postFn);

    expect(postFn).toHaveBeenCalledTimes(1);
    const [agent, msg] = postFn.mock.calls[0];
    expect(agent).toBe('release-agent');
    expect(msg).toContain('broken-app');
    expect(msg).toContain('Degraded');
  });

  it('does NOT call postFn for Healthy+Synced app', async () => {
    const payload = {
      app: {
        metadata: { name: 'healthy-app' },
        status: {
          sync: { status: 'Synced' },
          health: { status: 'Healthy' },
        },
      },
    };

    await routeArgoCD(payload, postFn);

    expect(postFn).not.toHaveBeenCalled();
  });
});

// ── webhook endpoints via supertest ────────────────────────────────────────

describe('webhook endpoints', () => {
  const secret = 'integration-secret';
  const token = 'integration-token';
  let postFn: jest.Mock;
  let app: express.Application;

  beforeEach(() => {
    jest.resetAllMocks();
    postFn = jest.fn().mockResolvedValue(undefined);
    app = createApp({ githubSecret: secret, webhookToken: token, postFn });
  });

  it('POST /webhook/github with invalid sig → 401', () => {
    return request(app)
      .post('/webhook/github')
      .set('x-hub-signature-256', 'sha256=invalid')
      .set('x-github-event', 'push')
      .send({ ref: 'refs/heads/main' })
      .expect(401);
  });

  it('POST /webhook/github with valid sig → 200 accepted', () => {
    return makeSignedRequest(app, { ref: 'refs/heads/main', commits: [], repository: { full_name: 'org/repo' } }, secret, 'push')
      .expect(200)
      .expect((r) => {
        expect(r.body.status).toBe('accepted');
      });
  });

  it('POST /webhook/alertmanager without token configured → 200 accepted', () => {
    const noTokenApp = createApp({ postFn });
    return request(noTokenApp)
      .post('/webhook/alertmanager')
      .send({ alerts: [] })
      .expect(200)
      .expect((r) => {
        expect(r.body.status).toBe('accepted');
      });
  });

  it('POST /webhook/alertmanager with wrong token → 401', () => {
    return request(app)
      .post('/webhook/alertmanager')
      .set('Authorization', 'Bearer wrong-token')
      .send({ alerts: [] })
      .expect(401);
  });

  it('POST /webhook/argocd with correct token → 200 accepted', () => {
    const payload = {
      app: {
        metadata: { name: 'test-app' },
        status: {
          sync: { status: 'Synced' },
          health: { status: 'Healthy' },
        },
      },
    };

    return request(app)
      .post('/webhook/argocd')
      .set('Authorization', `Bearer ${token}`)
      .send(payload)
      .expect(200)
      .expect((r) => {
        expect(r.body.status).toBe('accepted');
      });
  });
});
