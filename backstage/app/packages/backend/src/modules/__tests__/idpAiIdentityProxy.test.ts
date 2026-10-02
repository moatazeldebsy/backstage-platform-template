// The identity proxy exists for one property (docs/agent-approvals.md, ADP
// Phase 4b): KAgent must receive the caller's *verified* identity, never the
// X-Backstage-User header the browser chose to send. That header is what
// idp-mcp-server binds user memory to and what request_approval records as the
// requester, so a forgeable value there is an impersonation bug.
import { createIdentityProxyRouter } from '../idpAiIdentityProxy';
import { TEST_USER_HEADER, fakeHttpAuth, serve } from './routerHarness';

const logger = { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn(), child: jest.fn() };

function setup(fetchImpl: jest.Mock) {
  return serve(
    createIdentityProxyRouter({
      httpAuth: fakeHttpAuth(),
      logger: logger as any,
      kagentUrl: 'http://kagent.test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }),
  );
}

const rpcBody = { jsonrpc: '2.0', method: 'message/send', params: { message: { parts: [] } }, id: 1 };

describe('createIdentityProxyRouter', () => {
  afterEach(() => jest.clearAllMocks());

  it('forwards the verified identity and ignores a forged X-Backstage-User header', async () => {
    const upstream = jest.fn().mockResolvedValue(
      new Response('data: hello\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
    const srv = await setup(upstream);
    try {
      const res = await fetch(`${srv.url}/a2a/kagent/idp-assistant`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [TEST_USER_HEADER]: 'user:default/alice',
          // What an attacker with a valid session would try:
          'x-backstage-user': 'user:default/mallory',
        },
        body: JSON.stringify(rpcBody),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/event-stream');
      expect(await res.text()).toBe('data: hello\n\n');

      expect(upstream).toHaveBeenCalledTimes(1);
      const [target, init] = upstream.mock.calls[0];
      expect(target).toBe('http://kagent.test/a2a/kagent/idp-assistant');
      expect(init.headers['X-Backstage-User']).toBe('user:default/alice');
      expect(JSON.stringify(init.headers)).not.toContain('mallory');
      expect(JSON.parse(init.body)).toEqual(rpcBody);
    } finally {
      await srv.close();
    }
  });

  it('refuses an unauthenticated caller without contacting KAgent', async () => {
    const upstream = jest.fn();
    const srv = await setup(upstream);
    try {
      const res = await fetch(`${srv.url}/a2a/kagent/idp-assistant`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-backstage-user': 'user:default/alice' },
        body: JSON.stringify(rpcBody),
      });
      // Previously this rejection escaped the async handler and the request hung.
      expect(res.status).toBe(401);
      expect(upstream).not.toHaveBeenCalled();
    } finally {
      await srv.close();
    }
  });

  it('URL-encodes the agent name so it cannot walk to another KAgent path', async () => {
    const upstream = jest.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const srv = await setup(upstream);
    try {
      await fetch(`${srv.url}/a2a/kagent/${encodeURIComponent('../../api/sessions')}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [TEST_USER_HEADER]: 'user:default/alice' },
        body: '{}',
      });
      expect(upstream.mock.calls[0][0]).toBe('http://kagent.test/a2a/kagent/..%2F..%2Fapi%2Fsessions');
    } finally {
      await srv.close();
    }
  });

  it('answers 502 when KAgent is unreachable', async () => {
    const upstream = jest.fn().mockRejectedValue(new TypeError('fetch failed'));
    const srv = await setup(upstream);
    try {
      const res = await fetch(`${srv.url}/a2a/kagent/idp-assistant`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [TEST_USER_HEADER]: 'user:default/alice' },
        body: '{}',
      });
      expect(res.status).toBe(502);
      expect(logger.warn).toHaveBeenCalled();
    } finally {
      await srv.close();
    }
  });
});
