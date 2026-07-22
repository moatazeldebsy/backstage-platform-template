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

  it('routes firing non-budget alert to idp-assistant', async () => {
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
    expect(agent).toBe('idp-assistant');
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
    expect(postFn.mock.calls[1][0]).toBe('idp-assistant');
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
