import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../server.js';

jest.mock('node-fetch', () => {
  const mockFetch = jest.fn();
  return { default: mockFetch, __esModule: true };
});

const fetchMock = () => (require('node-fetch') as { default: jest.Mock }).default;

function makeResponse(body: unknown, status = 200) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

async function buildClient() {
  const server = createServer('test-agent');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

function parseResult(result: { content: Array<{ type: string; text?: string }> }): unknown {
  return JSON.parse(result.content.find(c => c.type === 'text')?.text ?? '{}');
}

type ErrorResult = { isError?: boolean; content: Array<{ text?: string }> };

beforeEach(() => jest.resetAllMocks());

// ── Shared mock app data ──────────────────────────────────────────────────────

const MOCK_APP = {
  metadata: { name: 'my-app', namespace: 'argocd' },
  spec: {
    destination: { namespace: 'services', server: 'https://k8s' },
    project: 'default',
  },
  status: {
    sync: { status: 'Synced' },
    health: { status: 'Healthy' },
  },
};

const MOCK_APP_DETAIL = {
  metadata: { name: 'my-app', creationTimestamp: '2024-01-01T00:00:00Z' },
  spec: {
    source: { repoURL: 'https://github.com/org/repo', targetRevision: 'main', path: 'helm/my-app' },
    project: 'default',
    destination: { namespace: 'services' },
  },
  status: {
    sync: { status: 'Synced', revision: 'abc123' },
    health: { status: 'Healthy', message: undefined },
    operationState: undefined,
    conditions: [],
  },
};

// ── list_apps ─────────────────────────────────────────────────────────────────

describe('list_apps', () => {
  it('returns app list with sync/health status', async () => {
    fetchMock().mockResolvedValueOnce(makeResponse({ items: [MOCK_APP] }));
    const client = await buildClient();
    const result = await client.callTool({ name: 'list_apps', arguments: {} });
    const data = parseResult(result as { content: Array<{ type: string; text?: string }> }) as {
      total: number;
      apps: Array<{ name: string; sync_status: string; health_status: string; project: string }>;
    };
    expect(data.total).toBe(1);
    expect(data.apps[0].name).toBe('my-app');
    expect(data.apps[0].sync_status).toBe('Synced');
    expect(data.apps[0].health_status).toBe('Healthy');
    expect(data.apps[0].project).toBe('default');
  });

  it('passes project param in URL query string', async () => {
    fetchMock().mockResolvedValueOnce(makeResponse({ items: [MOCK_APP] }));
    const client = await buildClient();
    await client.callTool({ name: 'list_apps', arguments: { project: 'my-project' } });
    const calledUrl: string = fetchMock().mock.calls[0][0];
    expect(calledUrl).toContain('project=my-project');
  });

  it('returns isError on non-ok response', async () => {
    fetchMock().mockResolvedValueOnce(makeResponse('Unauthorized', 401));
    const client = await buildClient();
    const result = await client.callTool({ name: 'list_apps', arguments: {} }) as ErrorResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('401');
  });
});

// ── get_app_health ────────────────────────────────────────────────────────────

describe('get_app_health', () => {
  it('returns full app detail object', async () => {
    fetchMock().mockResolvedValueOnce(makeResponse(MOCK_APP_DETAIL));
    const client = await buildClient();
    const result = await client.callTool({ name: 'get_app_health', arguments: { app_name: 'my-app' } });
    const data = parseResult(result as { content: Array<{ type: string; text?: string }> }) as {
      name: string;
      sync_status: string;
      health_status: string;
      repo: string;
    };
    expect(data.name).toBe('my-app');
    expect(data.sync_status).toBe('Synced');
    expect(data.health_status).toBe('Healthy');
    expect(data.repo).toBe('https://github.com/org/repo');
  });

  it('returns isError on 404', async () => {
    fetchMock().mockResolvedValueOnce(makeResponse('Not Found', 404));
    const client = await buildClient();
    const result = await client.callTool({ name: 'get_app_health', arguments: { app_name: 'missing-app' } }) as ErrorResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('404');
  });
});

// ── get_app_diff ──────────────────────────────────────────────────────────────

describe('get_app_diff', () => {
  const DIFF_ITEMS = [
    { group: 'apps', version: 'v1', kind: 'Deployment', name: 'svc', namespace: 'services', status: 'Synced', hook: false },
    { group: 'apps', version: 'v1', kind: 'Deployment', name: 'svc2', namespace: 'services', status: 'OutOfSync', hook: false, requiresPruning: true },
  ];

  it('returns only drifted resources (status !== Synced)', async () => {
    fetchMock().mockResolvedValueOnce(makeResponse({ items: DIFF_ITEMS }));
    const client = await buildClient();
    const result = await client.callTool({ name: 'get_app_diff', arguments: { app_name: 'my-app' } });
    const data = parseResult(result as { content: Array<{ type: string; text?: string }> }) as {
      total_resources: number;
      drifted_count: number;
      drifted_resources: Array<{ name: string; status: string; requires_pruning: boolean }>;
    };
    expect(data.total_resources).toBe(2);
    expect(data.drifted_count).toBe(1);
    expect(data.drifted_resources[0].name).toBe('svc2');
    expect(data.drifted_resources[0].status).toBe('OutOfSync');
    expect(data.drifted_resources[0].requires_pruning).toBe(true);
  });

  it('returns empty drifted_resources when all synced', async () => {
    const allSynced = [
      { group: 'apps', version: 'v1', kind: 'Deployment', name: 'svc', namespace: 'services', status: 'Synced', hook: false },
    ];
    fetchMock().mockResolvedValueOnce(makeResponse({ items: allSynced }));
    const client = await buildClient();
    const result = await client.callTool({ name: 'get_app_diff', arguments: { app_name: 'my-app' } });
    const data = parseResult(result as { content: Array<{ type: string; text?: string }> }) as {
      drifted_count: number;
      drifted_resources: unknown[];
    };
    expect(data.drifted_count).toBe(0);
    expect(data.drifted_resources).toHaveLength(0);
  });
});

// ── sync_app ──────────────────────────────────────────────────────────────────

describe('sync_app', () => {
  it('dry_run returns preview without calling fetch', async () => {
    const client = await buildClient();
    const result = await client.callTool({
      name: 'sync_app',
      arguments: { app_name: 'my-app', dry_run: true },
    });
    const data = parseResult(result as { content: Array<{ type: string; text?: string }> }) as {
      dry_run: boolean;
      app: string;
      message: string;
    };
    expect(data.dry_run).toBe(true);
    expect(data.app).toBe('my-app');
    expect(data.message).toContain('Dry run');
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it('real sync calls POST and returns operation_phase', async () => {
    const syncResponse = {
      metadata: { name: 'my-app' },
      status: { operationState: { phase: 'Succeeded', message: 'all good' } },
    };
    fetchMock().mockResolvedValueOnce(makeResponse(syncResponse));
    const client = await buildClient();
    const result = await client.callTool({
      name: 'sync_app',
      arguments: { app_name: 'my-app', dry_run: false },
    });
    const data = parseResult(result as { content: Array<{ type: string; text?: string }> }) as {
      app: string;
      operation_phase: string;
    };
    expect(data.app).toBe('my-app');
    expect(data.operation_phase).toBe('Succeeded');
    const calledInit = fetchMock().mock.calls[0][1];
    expect(calledInit.method).toBe('POST');
  });
});

// ── rollback_app ──────────────────────────────────────────────────────────────

describe('rollback_app', () => {
  it('dry_run returns preview without calling fetch', async () => {
    const client = await buildClient();
    const result = await client.callTool({
      name: 'rollback_app',
      arguments: { app_name: 'my-app', revision_id: 3, dry_run: true },
    });
    const data = parseResult(result as { content: Array<{ type: string; text?: string }> }) as {
      dry_run: boolean;
      revision_id: number;
      message: string;
    };
    expect(data.dry_run).toBe(true);
    expect(data.revision_id).toBe(3);
    expect(data.message).toContain('Dry run');
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it('real rollback calls POST and returns rollback_to', async () => {
    const rollbackResponse = {
      metadata: { name: 'my-app' },
      status: { operationState: { phase: 'Running', message: 'rolling back' } },
    };
    fetchMock().mockResolvedValueOnce(makeResponse(rollbackResponse));
    const client = await buildClient();
    const result = await client.callTool({
      name: 'rollback_app',
      arguments: { app_name: 'my-app', revision_id: 3, dry_run: false },
    });
    const data = parseResult(result as { content: Array<{ type: string; text?: string }> }) as {
      app: string;
      rollback_to: number;
      operation_phase: string;
    };
    expect(data.app).toBe('my-app');
    expect(data.rollback_to).toBe(3);
    expect(data.operation_phase).toBe('Running');
    const calledInit = fetchMock().mock.calls[0][1];
    expect(calledInit.method).toBe('POST');
  });
});
