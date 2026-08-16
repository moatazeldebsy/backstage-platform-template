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

// A gate that fails open silently is indistinguishable from a gate that works.
// That is exactly how approve_pr stayed ungated on the live cluster after
// ArgoCD selfHeal stripped APPROVAL_SERVICE_URL (docs/agent-approvals.md), so
// the warning is the thing under test here, not the approval logic.
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

describe('approve_pr with APPROVAL_SERVICE_URL unset', () => {
  it('proceeds ungated but records that it did', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    fetchMock().mockResolvedValueOnce(
      makeResponse({ id: 42, html_url: 'https://github.com/org/svc/pull/7#pullrequestreview-42' }),
    );

    const client = await buildClient();
    const result = await client.callTool({
      name: 'approve_pr',
      arguments: { repo: 'org/svc', pr_number: 7, dry_run: false },
    }) as { isError?: boolean };

    // No approval_id, no approval service — and the review is still posted.
    expect(result.isError).toBeFalsy();

    const audit = logSpy.mock.calls
      .map(args => String(args[0]))
      .filter(line => line.includes('approval_gate_disabled'));

    expect(audit).toHaveLength(1);
    const entry = JSON.parse(audit[0].replace('[AUDIT] ', ''));
    expect(entry.action).toBe('approve_pr');
    expect(entry.target).toBe('org/svc#7');
    expect(entry.warning).toContain('without human approval');

    logSpy.mockRestore();
  });
});
