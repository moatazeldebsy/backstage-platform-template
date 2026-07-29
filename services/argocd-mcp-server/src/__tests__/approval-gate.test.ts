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

function parseResult(result: { content: Array<{ type: string; text?: string }> }): unknown {
  return JSON.parse(result.content.find(c => c.type === 'text')?.text ?? '{}');
}

type ErrorResult = { isError?: boolean; content: Array<{ text?: string }> };

// APPROVAL_SERVICE_URL is read as a module-level const, so it must be set BEFORE
// the module is first required — reset the module registry and re-require here
// rather than importing statically at the top of the file.
let createServer: typeof import('../server.js')['createServer'];

beforeAll(() => {
  process.env.APPROVAL_SERVICE_URL = 'http://approval-service.services-dev.svc.cluster.local:3009';
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  ({ createServer } = require('../server.js'));
});

afterAll(() => {
  delete process.env.APPROVAL_SERVICE_URL;
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

describe('sync_app approval gate (APPROVAL_SERVICE_URL set)', () => {
  it('rejects a real sync with no approval_id', async () => {
    const client = await buildClient();
    const result = await client.callTool({ name: 'sync_app', arguments: { app_name: 'my-app', dry_run: false } }) as ErrorResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Approval required');
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it('rejects when the approval is not approved', async () => {
    fetchMock().mockResolvedValueOnce(makeResponse({ status: 'pending', action: 'sync_app', target: 'my-app' }));
    const client = await buildClient();
    const result = await client.callTool({ name: 'sync_app', arguments: { app_name: 'my-app', dry_run: false, approval_id: 'abc-1' } }) as ErrorResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('not approved');
  });

  it('rejects when the approval was for a different app', async () => {
    fetchMock().mockResolvedValueOnce(makeResponse({ status: 'approved', action: 'sync_app', target: 'other-app' }));
    const client = await buildClient();
    const result = await client.callTool({ name: 'sync_app', arguments: { app_name: 'my-app', dry_run: false, approval_id: 'abc-1' } }) as ErrorResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('different action/target');
  });

  it('proceeds when the approval is approved for this exact app', async () => {
    fetchMock()
      .mockResolvedValueOnce(makeResponse({ status: 'approved', action: 'sync_app', target: 'my-app' }))
      .mockResolvedValueOnce(makeResponse({ metadata: { name: 'my-app' }, status: { operationState: { phase: 'Running' } } }));
    const client = await buildClient();
    const result = await client.callTool({ name: 'sync_app', arguments: { app_name: 'my-app', dry_run: false, approval_id: 'abc-1' } });
    const data = parseResult(result as { content: Array<{ type: string; text?: string }> }) as { app: string };
    expect(data.app).toBe('my-app');
    expect(fetchMock()).toHaveBeenCalledTimes(2);
  });

  it('dry_run still short-circuits before any approval check', async () => {
    const client = await buildClient();
    const result = await client.callTool({ name: 'sync_app', arguments: { app_name: 'my-app', dry_run: true } });
    const data = parseResult(result as { content: Array<{ type: string; text?: string }> }) as { dry_run: boolean };
    expect(data.dry_run).toBe(true);
    expect(fetchMock()).not.toHaveBeenCalled();
  });
});
