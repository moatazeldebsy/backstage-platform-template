// The approval decision route exists for one property (docs/agent-approvals.md):
// approval-service must record the *verified* decider, never a decided_by the
// browser chose to send — otherwise anyone could approve under any name,
// including their own agent's request.
import { createApprovalDecisionRouter, resolveApprovalServiceUrl } from '../idpApprovalDecision';
import { TEST_USER_HEADER, fakeHttpAuth, serve } from './routerHarness';

const logger = { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn(), child: jest.fn() };

function setup(fetchImpl: jest.Mock) {
  return serve(
    createApprovalDecisionRouter({
      httpAuth: fakeHttpAuth(),
      logger: logger as any,
      approvalServiceUrl: 'http://approval.test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }),
  );
}

describe('createApprovalDecisionRouter', () => {
  afterEach(() => jest.clearAllMocks());

  it('sends the verified user as decided_by and ignores the one in the body', async () => {
    const upstream = jest.fn().mockResolvedValue(
      new Response('{"id":"a1","status":"approved"}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const srv = await setup(upstream);
    try {
      const res = await fetch(`${srv.url}/approvals/a1/decide`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [TEST_USER_HEADER]: 'user:default/alice' },
        body: JSON.stringify({ decision: 'approved', decided_by: 'user:default/mallory' }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: 'a1', status: 'approved' });
      const [target, init] = upstream.mock.calls[0];
      expect(target).toBe('http://approval.test/approvals/a1/decide');
      expect(JSON.parse(init.body)).toEqual({ decision: 'approved', decided_by: 'user:default/alice' });
    } finally {
      await srv.close();
    }
  });

  it('passes approval-service refusals (e.g. self-approval 403) through unchanged', async () => {
    const upstream = jest.fn().mockResolvedValue(
      new Response('{"error":"self-approval"}', { status: 403, headers: { 'content-type': 'application/json' } }),
    );
    const srv = await setup(upstream);
    try {
      const res = await fetch(`${srv.url}/approvals/a1/decide`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [TEST_USER_HEADER]: 'user:default/alice' },
        body: JSON.stringify({ decision: 'approved' }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'self-approval' });
    } finally {
      await srv.close();
    }
  });

  it('refuses an unauthenticated caller without contacting approval-service', async () => {
    const upstream = jest.fn();
    const srv = await setup(upstream);
    try {
      const res = await fetch(`${srv.url}/approvals/a1/decide`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'approved', decided_by: 'user:default/alice' }),
      });
      expect(res.status).toBe(401);
      expect(upstream).not.toHaveBeenCalled();
    } finally {
      await srv.close();
    }
  });

  it('400s an invalid decision without contacting approval-service', async () => {
    const upstream = jest.fn();
    const srv = await setup(upstream);
    try {
      const res = await fetch(`${srv.url}/approvals/a1/decide`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [TEST_USER_HEADER]: 'user:default/alice' },
        body: JSON.stringify({ decision: 'maybe' }),
      });
      expect(res.status).toBe(400);
      expect(upstream).not.toHaveBeenCalled();
    } finally {
      await srv.close();
    }
  });

  it('URL-encodes the approval id so it cannot walk to another path', async () => {
    const upstream = jest.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const srv = await setup(upstream);
    try {
      await fetch(`${srv.url}/approvals/${encodeURIComponent('../consent/grant')}/decide`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [TEST_USER_HEADER]: 'user:default/alice' },
        body: JSON.stringify({ decision: 'approved' }),
      });
      expect(upstream.mock.calls[0][0]).toBe('http://approval.test/approvals/..%2Fconsent%2Fgrant/decide');
    } finally {
      await srv.close();
    }
  });

  it('answers 502 when approval-service is unreachable', async () => {
    const upstream = jest.fn().mockRejectedValue(new TypeError('fetch failed'));
    const srv = await setup(upstream);
    try {
      const res = await fetch(`${srv.url}/approvals/a1/decide`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [TEST_USER_HEADER]: 'user:default/alice' },
        body: JSON.stringify({ decision: 'denied' }),
      });
      expect(res.status).toBe(502);
      expect(logger.warn).toHaveBeenCalled();
    } finally {
      await srv.close();
    }
  });
});

describe('resolveApprovalServiceUrl', () => {
  const saved = process.env.APPROVAL_SERVICE_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.APPROVAL_SERVICE_URL;
    else process.env.APPROVAL_SERVICE_URL = saved;
  });

  it('reads the /approval-service proxy target', () => {
    delete process.env.APPROVAL_SERVICE_URL;
    expect(resolveApprovalServiceUrl({ '/approval-service': { target: 'http://a:3009' } })).toBe('http://a:3009');
    expect(resolveApprovalServiceUrl({ '/approval-service': 'http://b:3009' })).toBe('http://b:3009');
    expect(resolveApprovalServiceUrl({})).toBeUndefined();
    expect(resolveApprovalServiceUrl(undefined)).toBeUndefined();
  });

  it('lets APPROVAL_SERVICE_URL override', () => {
    process.env.APPROVAL_SERVICE_URL = 'http://override:1';
    expect(resolveApprovalServiceUrl({ '/approval-service': { target: 'http://a:3009' } })).toBe('http://override:1');
  });
});
