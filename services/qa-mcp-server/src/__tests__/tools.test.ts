import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, TEST_SUITE_TEMPLATES } from '../server.js';

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
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

function parseResult(result: { content: Array<{ type: string; text?: string }> }): unknown {
  return JSON.parse(result.content.find(c => c.type === 'text')?.text ?? '[]');
}

beforeEach(() => jest.resetAllMocks());

// ── list_test_suites ──────────────────────────────────────────────────────────

describe('list_test_suites', () => {
  it('returns only test-suite type templates from catalog', async () => {
    const catalogEntities = [
      {
        metadata: { name: 'playwright-e2e-suite', title: 'Playwright E2E', description: 'E2E tests', tags: ['qa'] },
        spec: { type: 'test-suite' },
      },
      {
        metadata: { name: 'some-service', description: 'A regular service', tags: [] },
        spec: { type: 'service' },
      },
    ];
    fetchMock().mockResolvedValueOnce(makeResponse(catalogEntities));
    const client = await buildClient();
    const result = await client.callTool({ name: 'list_test_suites', arguments: {} });
    const data = parseResult(result as { content: Array<{ type: string; text?: string }> }) as Array<{
      name: string;
      templateRef: string;
    }>;
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(1);
    expect(data[0].name).toBe('playwright-e2e-suite');
    expect(data[0].templateRef).toBe('template:default/playwright-e2e-suite');
  });

  it('also returns templates matching TEST_SUITE_TEMPLATES names even without type', async () => {
    const catalogEntities = [
      {
        metadata: { name: 'k6-performance-suite', description: 'Load tests', tags: [] },
        spec: { type: 'template' },  // not 'test-suite' but name is in the set
      },
      {
        metadata: { name: 'unknown-thing', description: 'Something else', tags: [] },
        spec: { type: 'template' },
      },
    ];
    fetchMock().mockResolvedValueOnce(makeResponse(catalogEntities));
    const client = await buildClient();
    const result = await client.callTool({ name: 'list_test_suites', arguments: {} });
    const data = parseResult(result as { content: Array<{ type: string; text?: string }> }) as Array<{ name: string }>;
    expect(data.some(d => d.name === 'k6-performance-suite')).toBe(true);
    expect(data.some(d => d.name === 'unknown-thing')).toBe(false);
  });
});

// ── scaffold_test_suite ───────────────────────────────────────────────────────

describe('scaffold_test_suite', () => {
  it('rejects unknown template_ref with error message', async () => {
    const client = await buildClient();
    const result = await client.callTool({
      name: 'scaffold_test_suite',
      arguments: {
        template_ref: 'template:default/not-a-real-suite',
        values: { name: 'test', description: 'test', owner: 'group:default/qa-team' },
      },
    });
    const data = parseResult(result as { content: Array<{ type: string; text?: string }> }) as { error: string };
    expect(data.error).toContain('not-a-real-suite');
    expect(data.error).toContain('is not a test-suite template');
    // Should NOT have called fetch
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it('accepts known template and polls for completion', async () => {
    // First call: POST to create task
    const taskResponse = { id: 'task-abc-123' };
    // Second call: GET status (completed)
    const statusResponse = { status: 'completed', output: { repoUrl: 'https://github.com/org/my-pact-tests' } };

    fetchMock()
      .mockResolvedValueOnce(makeResponse(taskResponse))        // POST /tasks
      .mockResolvedValueOnce(makeResponse(statusResponse));     // GET /tasks/:id

    const client = await buildClient();
    const result = await client.callTool({
      name: 'scaffold_test_suite',
      arguments: {
        template_ref: 'template:default/playwright-e2e-suite',
        values: {
          name: 'my-e2e-tests',
          description: 'E2E test suite',
          owner: 'group:default/qa-team',
          repoUrl: 'github.com?owner=org&repo=my-e2e-tests',
        },
      },
    });
    const data = parseResult(result as { content: Array<{ type: string; text?: string }> }) as {
      task_id: string;
      status: string;
      ui_url: string;
    };
    expect(data.task_id).toBe('task-abc-123');
    expect(data.status).toBe('completed');
    expect(data.ui_url).toContain('task-abc-123');
  }, 30000);

  it('auto-builds repoUrl when not provided', async () => {
    const taskResponse = { id: 'task-xyz-456' };
    const statusResponse = { status: 'completed', output: {} };

    fetchMock()
      .mockResolvedValueOnce(makeResponse(taskResponse))
      .mockResolvedValueOnce(makeResponse(statusResponse));

    const client = await buildClient();
    await client.callTool({
      name: 'scaffold_test_suite',
      arguments: {
        template_ref: 'template:default/pact-contract-suite',
        values: {
          name: 'my-pact-tests',
          description: 'Contract tests',
          owner: 'group:default/qa-team',
          // repoUrl intentionally omitted
        },
      },
    });

    // Check that the POST body includes a repoUrl with the expected format
    const postCall = fetchMock().mock.calls[0];
    const postBody = JSON.parse(postCall[1].body as string);
    expect(postBody.values.repoUrl).toContain('github.com?owner=');
    expect(postBody.values.repoUrl).toContain('repo=my-pact-tests');
  }, 30000);
});

// ── search_test_catalog ───────────────────────────────────────────────────────

describe('search_test_catalog', () => {
  const CATALOG_ENTITIES = [
    {
      metadata: { name: 'playwright-e2e-suite', description: 'E2E test suite for web', tags: ['qa', 'e2e'] },
      kind: 'Template',
      spec: { type: 'test-suite', owner: 'group:default/qa-team' },
    },
    {
      metadata: { name: 'hello-service', description: 'The hello microservice', tags: ['api'] },
      kind: 'Component',
      spec: { type: 'service', owner: 'group:default/platform' },
    },
    {
      metadata: { name: 'pact-contract-tests', description: 'Contract tests for hello-service', tags: ['testing'] },
      kind: 'Template',
      spec: { type: 'test-suite', owner: 'group:default/qa-team' },
    },
  ];

  it('returns entities tagged "qa" or "testing"', async () => {
    fetchMock().mockResolvedValueOnce(makeResponse(CATALOG_ENTITIES));
    const client = await buildClient();
    const result = await client.callTool({
      name: 'search_test_catalog',
      arguments: { query: 'contract' },
    });
    const data = parseResult(result as { content: Array<{ type: string; text?: string }> }) as Array<{ name: string }>;
    // Should include pact-contract-tests (tagged testing + name matches)
    expect(data.some(d => d.name === 'pact-contract-tests')).toBe(true);
    // Should NOT include hello-service (no qa/testing tags and name doesn't match)
    expect(data.some(d => d.name === 'hello-service')).toBe(false);
  });

  it('matches query in name/description', async () => {
    fetchMock().mockResolvedValueOnce(makeResponse(CATALOG_ENTITIES));
    const client = await buildClient();
    const result = await client.callTool({
      name: 'search_test_catalog',
      arguments: { query: 'e2e' },
    });
    const data = parseResult(result as { content: Array<{ type: string; text?: string }> }) as Array<{ name: string }>;
    expect(data.some(d => d.name === 'playwright-e2e-suite')).toBe(true);
  });

  it('filters by service when provided', async () => {
    fetchMock().mockResolvedValueOnce(makeResponse(CATALOG_ENTITIES));
    const client = await buildClient();
    const result = await client.callTool({
      name: 'search_test_catalog',
      arguments: { query: 'test', service: 'hello-service' },
    });
    const data = parseResult(result as { content: Array<{ type: string; text?: string }> }) as Array<{ name: string }>;
    // pact-contract-tests description mentions hello-service
    expect(data.some(d => d.name === 'pact-contract-tests')).toBe(true);
    // playwright-e2e-suite doesn't mention hello-service
    expect(data.some(d => d.name === 'playwright-e2e-suite')).toBe(false);
  });
});

// ── get_test_metrics ──────────────────────────────────────────────────────────

describe('get_test_metrics', () => {
  function makePromResponse(metricName: string, value: string, jobName: string) {
    return makeResponse({
      data: {
        result: [{
          metric: { __name__: metricName, job: jobName },
          value: [Math.floor(Date.now() / 1000), value],
        }],
      },
    });
  }

  function makeEmptyPromResponse() {
    return makeResponse({ data: { result: [] } });
  }

  it('returns results when Prometheus has data', async () => {
    // 4 queries attempted, first one returns data
    fetchMock()
      .mockResolvedValueOnce(makePromResponse('test_runs_total', '42', 'hello-service'))
      .mockResolvedValueOnce(makeEmptyPromResponse())
      .mockResolvedValueOnce(makeEmptyPromResponse())
      .mockResolvedValueOnce(makeEmptyPromResponse());

    const client = await buildClient();
    const result = await client.callTool({
      name: 'get_test_metrics',
      arguments: { service_name: 'hello-service' },
    });
    const rawText = (result as { content: Array<{ type: string; text?: string }> })
      .content.find(c => c.type === 'text')?.text ?? '';
    // Should be JSON array of results
    const data = JSON.parse(rawText) as Array<{ query: string; data: unknown[] }>;
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
    expect(data[0].query).toContain('hello-service');
    expect(data[0].data).toHaveLength(1);
  });

  it('returns "no test metrics" message when all queries return empty', async () => {
    fetchMock()
      .mockResolvedValueOnce(makeEmptyPromResponse())
      .mockResolvedValueOnce(makeEmptyPromResponse())
      .mockResolvedValueOnce(makeEmptyPromResponse())
      .mockResolvedValueOnce(makeEmptyPromResponse());

    const client = await buildClient();
    const result = await client.callTool({
      name: 'get_test_metrics',
      arguments: { service_name: 'no-metrics-service' },
    });
    const rawText = (result as { content: Array<{ type: string; text?: string }> })
      .content.find(c => c.type === 'text')?.text ?? '';
    expect(rawText).toContain('No test metrics found');
    expect(rawText).toContain('no-metrics-service');
  });

  it('skips failed individual queries and continues', async () => {
    // First query throws, second returns data
    fetchMock()
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce(makePromResponse('test_duration_seconds', '1.5', 'hello-service'))
      .mockResolvedValueOnce(makeEmptyPromResponse())
      .mockResolvedValueOnce(makeEmptyPromResponse());

    const client = await buildClient();
    const result = await client.callTool({
      name: 'get_test_metrics',
      arguments: { service_name: 'hello-service' },
    });
    const rawText = (result as { content: Array<{ type: string; text?: string }> })
      .content.find(c => c.type === 'text')?.text ?? '';
    // Should still return results from the successful query
    const data = JSON.parse(rawText) as Array<{ query: string }>;
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  });
});
