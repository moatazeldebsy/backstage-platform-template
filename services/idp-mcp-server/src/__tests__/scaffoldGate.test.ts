// scaffold_service approval gate. APPROVAL_SERVICE_URL is read at module load,
// so each test loads a fresh module instance (same pattern as consent.test.ts).

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

jest.mock('node-fetch', () => {
  const mockFetch = jest.fn();
  return { default: mockFetch, __esModule: true };
});

const ORIGINAL_ENV = process.env;
const APPROVALS = 'http://approval-service:3009';
const TEMPLATE = 'template:default/s3-bucket-crossplane';
const VALUES = { name: 'orders-bucket', ownerService: 'orders-service' };

type Server = typeof import('../server.js');

function makeResponse(body: unknown, status = 200) {
  const text = JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) };
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fetchMock = () => (require('node-fetch') as { default: jest.Mock }).default;

// Route mocked fetches by URL so tests don't depend on call order.
function routeFetch(routes: Record<string, (init?: { body?: string }) => unknown>) {
  fetchMock().mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
    const key = Object.keys(routes).find(k => {
      const [method, path] = k.split(' ');
      return (init?.method ?? 'GET') === method && url.includes(path);
    });
    if (!key) throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${url}`);
    return routes[key](init);
  });
}

function calledUrls(): string[] {
  return fetchMock().mock.calls.map(c => `${(c[1] as { method?: string } | undefined)?.method ?? 'GET'} ${c[0] as string}`);
}

async function load(withApprovals = true): Promise<Server> {
  if (withApprovals) process.env.APPROVAL_SERVICE_URL = APPROVALS;
  else delete process.env.APPROVAL_SERVICE_URL;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../server.js') as Server;
}

async function callScaffold(mod: Server, args: Record<string, unknown>) {
  // Empty userRef keeps checkConsent out of these tests (covered in consent.test.ts).
  const server = mod.createServer('provisioning-agent', '');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);
  const result = await client.callTool({ name: 'scaffold_service', arguments: args }) as { content: Array<{ text?: string }> };
  return JSON.parse(result.content[0].text ?? '{}') as Record<string, unknown>;
}

const scaffolderRoutes = {
  'POST /api/scaffolder/v2/tasks': () => makeResponse({ id: 'task-1' }, 201),
  'GET /api/scaffolder/v2/tasks/task-1': () => makeResponse({ status: 'completed', output: {} }),
};

beforeEach(() => {
  jest.resetModules();
  jest.resetAllMocks();
  process.env = { ...ORIGINAL_ENV };
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('canonicalJson / valuesSha256', () => {
  it('ignores key order', async () => {
    const mod = await load();
    expect(mod.valuesSha256({ a: 1, b: { c: 2, d: 3 } })).toBe(mod.valuesSha256({ b: { d: 3, c: 2 }, a: 1 }));
    expect(mod.valuesSha256({ a: 1 })).not.toBe(mod.valuesSha256({ a: 2 }));
  });
});

describe('scaffold_service approval gate', () => {
  it('files an approval with cost and values hash, and does not scaffold, when policy requires approval', async () => {
    const mod = await load();
    let approvalBody: Record<string, unknown> = {};
    routeFetch({
      'POST /policy/check': () => makeResponse({ requires_approval: true, reason: 'AWS resource' }),
      'GET /api/catalog/entities/by-name/Template/default/s3-bucket-crossplane': () =>
        makeResponse({ metadata: { annotations: { 'idp.io/estimated-monthly-usd': '5' } } }),
      'POST /approvals': init => { approvalBody = JSON.parse(init?.body ?? '{}'); return makeResponse({ id: 'appr-1', status: 'pending' }, 201); },
    });

    const res = await callScaffold(mod, { template_ref: TEMPLATE, values: VALUES, reason: 'orders need storage' });

    expect(res.status).toBe('pending_approval');
    expect(res.approval_id).toBe('appr-1');
    expect(res.estimated_monthly_usd).toBe('5');
    expect(approvalBody.action).toBe('scaffold_service');
    expect(approvalBody.target).toBe('s3-bucket-crossplane');
    const ctx = approvalBody.context as Record<string, unknown>;
    expect(ctx.reason).toBe('orders need storage');
    expect(ctx.values_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(calledUrls().some(u => u.includes('/api/scaffolder/'))).toBe(false);
  });

  it('records "unknown" cost when the template has no estimate annotation', async () => {
    const mod = await load();
    routeFetch({
      'POST /policy/check': () => makeResponse({ requires_approval: true, reason: 'r' }),
      'GET /api/catalog/entities/by-name/': () => makeResponse({ metadata: {} }),
      'POST /approvals': () => makeResponse({ id: 'appr-2', status: 'pending' }, 201),
    });
    const res = await callScaffold(mod, { template_ref: TEMPLATE, values: VALUES });
    expect(res.estimated_monthly_usd).toBe('unknown');
  });

  it('scaffolds with an approved approval whose template and values hash match', async () => {
    const mod = await load();
    // The hash covers the enriched values scaffold_service actually sends.
    const enriched = { ...VALUES, repoUrl: (await import('../utils.js')).normalizeRepoUrl({ ...VALUES }) };
    routeFetch({
      'GET /approvals/appr-1': () => makeResponse({ status: 'approved', action: 'scaffold_service', target: 's3-bucket-crossplane', context: { values: enriched } }),
      ...scaffolderRoutes,
    });
    const res = await callScaffold(mod, { template_ref: TEMPLATE, values: VALUES, approval_id: 'appr-1' });
    expect(res.task_id).toBe('task-1');
    expect(calledUrls().some(u => u.includes('/policy/check'))).toBe(false);
  });

  it.each<[string, Record<string, unknown> | 'FORGED' | null, string]>([
    ['values changed', { status: 'approved', action: 'scaffold_service', target: 's3-bucket-crossplane', context: { values: { ...VALUES, name: 'other-bucket' } } }, 'values differ'],
    ['shown different values than its stored hash', 'FORGED', 'values differ'],
    ['different template', { status: 'approved', action: 'scaffold_service', target: 'rds-database-crossplane', context: {} }, 'different action or template'],
    ['still pending', null, 'status is pending'],
    ['denied', null, 'status is denied'],
  ])('refuses an approval that is %s', async (_label, approvalOverride, problem) => {
    const mod = await load();
    const enriched = { ...VALUES, repoUrl: (await import('../utils.js')).normalizeRepoUrl({ ...VALUES }) };
    const status = problem.includes('pending') ? 'pending' : 'denied';
    const approval = approvalOverride === 'FORGED'
      // A stored hash of the real values, but the approver was shown other values.
      ? { status: 'approved', action: 'scaffold_service', target: 's3-bucket-crossplane', context: { values: { name: 'harmless' }, values_sha256: mod.valuesSha256(enriched) } }
      : approvalOverride ?? { status, action: 'scaffold_service', target: 's3-bucket-crossplane', context: { values: enriched } };
    routeFetch({ 'GET /approvals/appr-1': () => makeResponse(approval), ...scaffolderRoutes });

    const res = await callScaffold(mod, { template_ref: TEMPLATE, values: VALUES, approval_id: 'appr-1' });

    expect(res.error).toBe('approval_not_valid');
    expect(String(res.message)).toContain(problem);
    expect(calledUrls().some(u => u.includes('/api/scaffolder/'))).toBe(false);
  });

  it('scaffolds straight away when policy auto-approves the template', async () => {
    const mod = await load();
    routeFetch({ 'POST /policy/check': () => makeResponse({ requires_approval: false, reason: 'low risk' }), ...scaffolderRoutes });
    const res = await callScaffold(mod, { template_ref: 'template:default/slo-definition', values: { name: 'x' } });
    expect(res.task_id).toBe('task-1');
    expect(calledUrls().some(u => u.includes('POST') && u.endsWith('/approvals'))).toBe(false);
  });

  it('fails open with an audit line when approval-service is not deployed', async () => {
    const mod = await load(false);
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    routeFetch(scaffolderRoutes);
    const res = await callScaffold(mod, { template_ref: TEMPLATE, values: VALUES });
    expect(res.task_id).toBe('task-1');
    expect(log.mock.calls.some(c => String(c[0]).includes('approval_gate_disabled'))).toBe(true);
    log.mockRestore();
  });
});

describe('request_approval', () => {
  it('refuses scaffold_service, which must file its own approval', async () => {
    const mod = await load();
    const server = mod.createServer('idp-assistant', '');
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
    await client.connect(ct);
    const result = await client.callTool({ name: 'request_approval', arguments: {
      action: 'scaffold_service', target: 's3-bucket-crossplane', context: { summary: 'harmless', values_sha256: 'x' } } }) as { content: Array<{ text?: string }> };
    expect(result.content[0].text).toContain('Call scaffold_service directly');
    expect(fetchMock()).not.toHaveBeenCalled();
  });
});
