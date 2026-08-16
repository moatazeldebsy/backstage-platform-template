import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

jest.mock('node-fetch', () => {
  const mockFetch = jest.fn();
  return { default: mockFetch, __esModule: true };
});

const fetchMock = () => (require('node-fetch') as { default: jest.Mock }).default;

function makeResponse(body: unknown, status = 200) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) };
}

// The mirror of approval-gate.test.ts: that file proves the gate rejects when
// APPROVAL_SERVICE_URL is set, this one proves an unset URL still leaves a
// trace. Both matter — a gate that fails open silently is indistinguishable
// from a gate that works, which is exactly how it stayed broken on the live
// cluster after ArgoCD selfHeal stripped the variable (docs/agent-approvals.md).
//
// APPROVAL_SERVICE_URL is read as a module-level const, so it must be unset
// BEFORE the module is first required.
let createServer: typeof import('../server.js')['createServer'];

beforeAll(() => {
  delete process.env.APPROVAL_SERVICE_URL;
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  ({ createServer } = require('../server.js'));
});

beforeEach(() => jest.resetAllMocks());

async function buildClient() {
  const server = createServer('release-agent');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

describe('sync_app with APPROVAL_SERVICE_URL unset', () => {
  it('proceeds ungated but records that it did', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    fetchMock().mockResolvedValueOnce(
      makeResponse({ metadata: { name: 'my-app' }, status: { operationState: { phase: 'Running' } } }),
    );

    const client = await buildClient();
    const result = await client.callTool({
      name: 'sync_app',
      arguments: { app_name: 'my-app', dry_run: false },
    }) as { isError?: boolean };

    // No approval_id, no approval service — and the sync still happens.
    expect(result.isError).toBeFalsy();

    const audit = logSpy.mock.calls
      .map(args => String(args[0]))
      .filter(line => line.includes('approval_gate_disabled'));

    expect(audit).toHaveLength(1);
    const entry = JSON.parse(audit[0].replace('[AUDIT] ', ''));
    expect(entry.action).toBe('sync_app');
    expect(entry.target).toBe('my-app');
    expect(entry.warning).toContain('without human approval');

    logSpy.mockRestore();
  });
});
