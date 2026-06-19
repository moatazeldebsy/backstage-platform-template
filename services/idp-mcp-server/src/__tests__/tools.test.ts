// Tool handler integration tests — use InMemoryTransport to connect a real
// McpServer (from createServer) to a real MCP Client in-process, with
// node-fetch fully mocked so no network calls leave the test process.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, clearAllCaches } from '../server.js';

// ── node-fetch mock ───────────────────────────────────────────────────────────
// Must be declared before any import resolves the real module.

jest.mock('node-fetch', () => {
  const mockFetch = jest.fn();
  return { default: mockFetch, __esModule: true };
});

// Helper to get the typed mock after jest has set it up.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fetchMock = () => (require('node-fetch') as { default: jest.Mock }).default;

// Build a minimal fetch Response-alike that our helpers accept.
function makeResponse(body: unknown, status = 200) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

// ── Test helpers ──────────────────────────────────────────────────────────────

async function buildClient(agentId = 'test-agent', userRef = 'user:default/tester') {
  const server = createServer(agentId, userRef);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

function parseResult(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const text = result.content.find(c => c.type === 'text')?.text ?? '{}';
  return JSON.parse(text);
}

// ── Test suite ────────────────────────────────────────────────────────────────

beforeEach(() => {
  clearAllCaches();
  // resetAllMocks clears call history AND mockResolvedValue default implementations.
  // clearAllMocks leaves default implementations in place, which causes cross-test
  // mock leakage when one test uses mockResolvedValue (not Once).
  jest.resetAllMocks();
});

// ── catalog_search ────────────────────────────────────────────────────────────

describe('catalog_search', () => {
  it('returns exact match results from the catalog', async () => {
    fetchMock().mockResolvedValueOnce(makeResponse([
      { metadata: { name: 'hello-service', description: 'The hello service' }, kind: 'Component', spec: { type: 'service', owner: 'team-a' } },
    ]));
    const client = await buildClient();
    const result = await client.callTool({ name: 'catalog_search', arguments: { query: 'hello-service' } });
    const parsed = parseResult(result as Parameters<typeof parseResult>[0]) as Array<{ name: string }>;
    expect(parsed[0].name).toBe('hello-service');
  });

  it('falls back to fuzzy match when exact returns empty', async () => {
    fetchMock()
      .mockResolvedValueOnce(makeResponse([]))          // exact — empty
      .mockResolvedValueOnce(makeResponse([             // all — 200 items subset
        { metadata: { name: 'hello-world', description: 'says hello' }, kind: 'Component', spec: {} },
        { metadata: { name: 'goodbye-service', description: 'says goodbye' }, kind: 'Component', spec: {} },
      ]));
    const client = await buildClient();
    const result = await client.callTool({ name: 'catalog_search', arguments: { query: 'hello' } });
    const parsed = parseResult(result as Parameters<typeof parseResult>[0]) as Array<{ name: string }>;
    expect(parsed.some(r => r.name === 'hello-world')).toBe(true);
    expect(parsed.some(r => r.name === 'goodbye-service')).toBe(false);
  });

  it('serves cache hit without calling fetch a second time', async () => {
    fetchMock().mockResolvedValue(makeResponse([
      { metadata: { name: 'cached-service' }, kind: 'Component', spec: {} },
    ]));
    const client = await buildClient();
    await client.callTool({ name: 'catalog_search', arguments: { query: 'cached-service' } });
    await client.callTool({ name: 'catalog_search', arguments: { query: 'cached-service' } });
    expect(fetchMock()).toHaveBeenCalledTimes(1);
  });

  it('filters by kind when provided', async () => {
    fetchMock().mockResolvedValueOnce(makeResponse([
      { metadata: { name: 'my-api' }, kind: 'API', spec: {} },
    ]));
    const client = await buildClient();
    const result = await client.callTool({ name: 'catalog_search', arguments: { query: 'my-api', kind: 'API' } });
    const parsed = parseResult(result as Parameters<typeof parseResult>[0]) as Array<{ kind: string }>;
    expect(parsed[0].kind).toBe('API');
    // Verify the kind filter was included in the URL
    const calledUrl = fetchMock().mock.calls[0][0] as string;
    expect(calledUrl).toContain('filter=kind=API');
  });
});

// ── get_service_metrics ───────────────────────────────────────────────────────

describe('get_service_metrics', () => {
  it('returns formatted metric results', async () => {
    fetchMock().mockResolvedValueOnce(makeResponse({
      data: {
        result: [
          { metric: { job: 'hello-service' }, value: [1718000000, '42'] },
        ],
      },
    }));
    const client = await buildClient();
    const result = await client.callTool({ name: 'get_service_metrics', arguments: { service_name: 'hello-service' } });
    const parsed = parseResult(result as Parameters<typeof parseResult>[0]) as Array<{ value: string; labels: { job: string } }>;
    expect(parsed[0].value).toBe('42');
    expect(parsed[0].labels.job).toBe('hello-service');
  });

  it('returns a human-readable message when no metrics are found', async () => {
    fetchMock().mockResolvedValueOnce(makeResponse({ data: { result: [] } }));
    const client = await buildClient();
    const result = await client.callTool({ name: 'get_service_metrics', arguments: { service_name: 'unknown-svc' } });
    const text = (result as { content: Array<{ text?: string }> }).content[0].text ?? '';
    expect(text).toContain('No metrics found');
    expect(text).toContain('unknown-svc');
  });
});

// ── scaffold_service ──────────────────────────────────────────────────────────

describe('scaffold_service', () => {
  it('returns dry_run preview without calling the Backstage API', async () => {
    const client = await buildClient();
    const result = await client.callTool({
      name: 'scaffold_service',
      arguments: { template_ref: 'template:default/nodejs-service', values: { name: 'my-svc', owner: 'team-a' }, dry_run: true },
    });
    const parsed = parseResult(result as Parameters<typeof parseResult>[0]) as { dry_run: boolean; template: string };
    expect(parsed.dry_run).toBe(true);
    expect(parsed.template).toBe('template:default/nodejs-service');
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it('polls until task completes and returns task_id + status', async () => {
    // POST → creates task; second call → status=completed
    fetchMock()
      .mockResolvedValueOnce(makeResponse({ id: 'task-123' }, 201))       // POST /tasks
      .mockResolvedValueOnce(makeResponse({ status: 'completed', output: { serviceUrl: 'http://hello' } })); // GET /tasks/:id

    const client = await buildClient();
    const result = await client.callTool({
      name: 'scaffold_service',
      arguments: { template_ref: 'template:default/nodejs-service', values: { name: 'my-svc', owner: 'team-a', repoUrl: 'github.com?owner=acme&repo=my-svc' } },
    });
    const parsed = parseResult(result as Parameters<typeof parseResult>[0]) as { task_id: string; status: string };
    expect(parsed.task_id).toBe('task-123');
    expect(parsed.status).toBe('completed');
  });
});

// ── list_deployments ──────────────────────────────────────────────────────────

describe('list_deployments', () => {
  it('queries both services-dev and services namespaces by default', async () => {
    const makeDeployment = (name: string, ns: string) => ({
      metadata: { name, namespace: ns },
      spec: { replicas: 1, template: { spec: { containers: [{ image: 'img:latest' }] } } },
      status: { readyReplicas: 1 },
    });
    fetchMock()
      .mockResolvedValueOnce(makeResponse({ items: [makeDeployment('svc-a', 'services-dev')] }))
      .mockResolvedValueOnce(makeResponse({ items: [makeDeployment('svc-b', 'services')] }));

    const client = await buildClient();
    const result = await client.callTool({ name: 'list_deployments', arguments: {} });
    const parsed = parseResult(result as Parameters<typeof parseResult>[0]) as Array<{ name: string }>;
    expect(parsed).toHaveLength(2);
    expect(parsed.map(d => d.name)).toContain('svc-a');
    expect(parsed.map(d => d.name)).toContain('svc-b');
  });

  it('queries only the given namespace when namespace is specified', async () => {
    fetchMock().mockResolvedValueOnce(makeResponse({
      items: [{
        metadata: { name: 'prod-svc', namespace: 'production' },
        spec: { replicas: 3, template: { spec: { containers: [{ image: 'img:v2' }] } } },
        status: { readyReplicas: 3 },
      }],
    }));
    const client = await buildClient();
    const result = await client.callTool({ name: 'list_deployments', arguments: { namespace: 'production' } });
    const parsed = parseResult(result as Parameters<typeof parseResult>[0]) as Array<{ namespace: string }>;
    expect(fetchMock()).toHaveBeenCalledTimes(1);
    expect(parsed[0].namespace).toBe('production');
  });
});

// ── list_templates ────────────────────────────────────────────────────────────

describe('list_templates', () => {
  it('returns template list from catalog', async () => {
    fetchMock().mockResolvedValueOnce(makeResponse([
      { metadata: { name: 'nodejs-service', title: 'Node.js Service', description: 'Create a Node.js service' }, spec: { type: 'service' } },
    ]));
    const client = await buildClient();
    const result = await client.callTool({ name: 'list_templates', arguments: {} });
    const parsed = parseResult(result as Parameters<typeof parseResult>[0]) as Array<{ name: string; templateRef: string }>;
    expect(parsed[0].name).toBe('nodejs-service');
    expect(parsed[0].templateRef).toBe('template:default/nodejs-service');
  });

  it('serves second call from cache', async () => {
    fetchMock().mockResolvedValue(makeResponse([
      { metadata: { name: 'go-service' }, spec: {} },
    ]));
    const client = await buildClient();
    await client.callTool({ name: 'list_templates', arguments: {} });
    await client.callTool({ name: 'list_templates', arguments: {} });
    expect(fetchMock()).toHaveBeenCalledTimes(1);
  });
});

// ── get_template_params ───────────────────────────────────────────────────────

describe('get_template_params', () => {
  it('fetches template by parsed namespace and name', async () => {
    fetchMock().mockResolvedValueOnce(makeResponse({
      metadata: { name: 'nodejs-service', title: 'Node.js Service', description: 'desc' },
      spec: { parameters: [{ title: 'Service Info', required: ['name'], properties: { name: { type: 'string' } } }] },
    }));
    const client = await buildClient();
    const result = await client.callTool({ name: 'get_template_params', arguments: { template_ref: 'template:default/nodejs-service' } });
    const parsed = parseResult(result as Parameters<typeof parseResult>[0]) as { name: string; parameters: unknown[] };
    expect(parsed.name).toBe('nodejs-service');
    expect(parsed.parameters).toHaveLength(1);
    // Verify URL contained parsed namespace and name
    const calledUrl = fetchMock().mock.calls[0][0] as string;
    expect(calledUrl).toContain('/Template/default/nodejs-service');
  });

  it('caches the second call', async () => {
    fetchMock().mockResolvedValue(makeResponse({
      metadata: { name: 'go-service' },
      spec: { parameters: [] },
    }));
    const client = await buildClient();
    await client.callTool({ name: 'get_template_params', arguments: { template_ref: 'template:default/go-service' } });
    await client.callTool({ name: 'get_template_params', arguments: { template_ref: 'template:default/go-service' } });
    expect(fetchMock()).toHaveBeenCalledTimes(1);
  });
});

// ── get_user_memory ───────────────────────────────────────────────────────────

describe('get_user_memory', () => {
  it('returns empty preferences when ConfigMap does not exist (404)', async () => {
    fetchMock().mockResolvedValueOnce(makeResponse('Not Found', 404));
    const client = await buildClient();
    const result = await client.callTool({ name: 'get_user_memory', arguments: {} });
    const parsed = parseResult(result as Parameters<typeof parseResult>[0]) as { preferences: Record<string, unknown> };
    expect(parsed.preferences).toEqual({});
  });

  it('returns stored preferences when ConfigMap exists', async () => {
    fetchMock().mockResolvedValueOnce(makeResponse({
      data: { preferences: JSON.stringify({ preferredLanguage: 'TypeScript', scaffoldCount: 3 }) },
    }));
    const client = await buildClient();
    const result = await client.callTool({ name: 'get_user_memory', arguments: {} });
    const parsed = parseResult(result as Parameters<typeof parseResult>[0]) as { preferences: { preferredLanguage: string } };
    expect(parsed.preferences.preferredLanguage).toBe('TypeScript');
  });

  it('derives ConfigMap name from userRef (IDOR guard)', async () => {
    fetchMock().mockResolvedValueOnce(makeResponse('Not Found', 404));
    const client = await buildClient('agent-x', 'user:default/alice');
    await client.callTool({ name: 'get_user_memory', arguments: {} });
    expect(fetchMock().mock.calls[0][0] as string).toContain('user-memory-user-default-alice');
  });
});

// ── set_user_memory ───────────────────────────────────────────────────────────

describe('set_user_memory', () => {
  it('POSTs a new ConfigMap when one does not exist', async () => {
    fetchMock()
      .mockResolvedValueOnce(makeResponse('Not Found', 404)) // GET (check exists)
      .mockResolvedValueOnce(makeResponse({ metadata: { name: 'cm' } }, 201)); // POST
    const client = await buildClient();
    const result = await client.callTool({ name: 'set_user_memory', arguments: { key: 'preferredLanguage', value: 'Go' } });
    const parsed = parseResult(result as Parameters<typeof parseResult>[0]) as { updated: { preferredLanguage: string } };
    expect(parsed.updated.preferredLanguage).toBe('Go');
    const [, putInit] = fetchMock().mock.calls[1] as [string, { method: string }];
    expect(putInit.method).toBe('POST');
  });

  it('PUTs an existing ConfigMap when one already exists', async () => {
    fetchMock()
      .mockResolvedValueOnce(makeResponse({ data: { preferences: JSON.stringify({ preferredLanguage: 'Python' }) } })) // GET
      .mockResolvedValueOnce(makeResponse({ metadata: { name: 'cm' } })); // PUT
    const client = await buildClient();
    const result = await client.callTool({ name: 'set_user_memory', arguments: { key: 'preferredLanguage', value: 'Go' } });
    const parsed = parseResult(result as Parameters<typeof parseResult>[0]) as { updated: { preferredLanguage: string } };
    expect(parsed.updated.preferredLanguage).toBe('Go');
    const [, putInit] = fetchMock().mock.calls[1] as [string, { method: string }];
    expect(putInit.method).toBe('PUT');
  });

  it('coerces recentServices to an array', async () => {
    fetchMock()
      .mockResolvedValueOnce(makeResponse('Not Found', 404))
      .mockResolvedValueOnce(makeResponse({}));
    const client = await buildClient();
    const result = await client.callTool({ name: 'set_user_memory', arguments: { key: 'recentServices', value: 'svc-a,svc-b,svc-c' } });
    const parsed = parseResult(result as Parameters<typeof parseResult>[0]) as { updated: { recentServices: string[] } };
    expect(parsed.updated.recentServices).toEqual(['svc-a', 'svc-b', 'svc-c']);
  });
});

// ── catalog_semantic_search ───────────────────────────────────────────────────

describe('catalog_semantic_search', () => {
  it('returns results up to the requested limit', async () => {
    fetchMock().mockResolvedValueOnce(makeResponse({
      results: [
        { title: 'Payments API', text: 'handles billing', location: '/catalog/payments-api', score: 0.95 },
        { title: 'Auth Service',  text: 'handles auth',   location: '/catalog/auth-service',  score: 0.80 },
        { title: 'Logging Svc',  text: 'handles logs',   location: '/catalog/logging-svc',   score: 0.70 },
      ],
    }));
    const client = await buildClient();
    const result = await client.callTool({ name: 'catalog_semantic_search', arguments: { query: 'payments', limit: 2 } });
    const parsed = parseResult(result as Parameters<typeof parseResult>[0]) as { total: number; results: unknown[] };
    expect(parsed.total).toBe(2);
    expect(parsed.results).toHaveLength(2);
  });

  it('returns an error result when upstream returns 503', async () => {
    fetchMock().mockResolvedValueOnce(makeResponse('Service Unavailable', 503));
    const client = await buildClient();
    // MCP SDK resolves (not rejects) with isError:true when a tool handler throws.
    const result = await client.callTool({ name: 'catalog_semantic_search', arguments: { query: 'anything' } }) as { isError?: boolean; content: Array<{ text?: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('503');
  });

  it('uses default limit of 5 when limit is not specified', async () => {
    const sixItems = Array.from({ length: 6 }, (_, i) => ({ title: `R${i}`, text: 't', location: '/l', score: 0.9 }));
    fetchMock().mockResolvedValueOnce(makeResponse({ results: sixItems }));
    const client = await buildClient();
    const result = await client.callTool({ name: 'catalog_semantic_search', arguments: { query: 'anything' } });
    const parsed = parseResult(result as Parameters<typeof parseResult>[0]) as { total: number };
    expect(parsed.total).toBe(5);
  });
});

// ── Error-path coverage ───────────────────────────────────────────────────────
// These tests verify that when upstream HTTP calls fail, tools return isError:true
// (MCP SDK wraps the thrown exception rather than propagating it as a rejection).

type ErrorResult = { isError?: boolean; content: Array<{ text?: string }> };

describe('error propagation', () => {
  it('catalog_search returns isError when catalog is unreachable', async () => {
    fetchMock().mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const client = await buildClient();
    const result = await client.callTool({ name: 'catalog_search', arguments: { query: 'x' } }) as ErrorResult;
    expect(result.isError).toBe(true);
  });

  it('catalog_search → fuzzy fallback also fails → isError', async () => {
    fetchMock()
      .mockResolvedValueOnce(makeResponse([]))              // exact search → empty
      .mockRejectedValueOnce(new Error('ECONNREFUSED'));    // all-entities fetch → throws
    const client = await buildClient();
    const result = await client.callTool({ name: 'catalog_search', arguments: { query: 'x' } }) as ErrorResult;
    expect(result.isError).toBe(true);
  });

  it('get_service_metrics returns isError when Prometheus is unreachable', async () => {
    fetchMock().mockRejectedValueOnce(new Error('timeout'));
    const client = await buildClient();
    const result = await client.callTool({ name: 'get_service_metrics', arguments: { service_name: 'svc' } }) as ErrorResult;
    expect(result.isError).toBe(true);
  });

  it('list_deployments returns isError when K8s API is unreachable', async () => {
    fetchMock().mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const client = await buildClient();
    const result = await client.callTool({ name: 'list_deployments', arguments: { namespace: 'services' } }) as ErrorResult;
    expect(result.isError).toBe(true);
  });

  it('list_templates returns isError when catalog call fails', async () => {
    fetchMock().mockRejectedValueOnce(new Error('timeout'));
    const client = await buildClient();
    const result = await client.callTool({ name: 'list_templates', arguments: {} }) as ErrorResult;
    expect(result.isError).toBe(true);
  });

  it('get_template_params returns isError when catalog call fails', async () => {
    fetchMock().mockRejectedValueOnce(new Error('timeout'));
    const client = await buildClient();
    const result = await client.callTool({ name: 'get_template_params', arguments: { template_ref: 'template:default/svc' } }) as ErrorResult;
    expect(result.isError).toBe(true);
  });

  it('get_user_memory returns isError on non-404 K8s error', async () => {
    fetchMock().mockResolvedValueOnce(makeResponse('Forbidden', 403));
    const client = await buildClient();
    const result = await client.callTool({ name: 'get_user_memory', arguments: {} }) as ErrorResult;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('403');
  });

  it('set_user_memory returns isError when PUT fails', async () => {
    fetchMock()
      .mockResolvedValueOnce(makeResponse({ data: { preferences: '{}' } })) // GET → exists
      .mockResolvedValueOnce(makeResponse('Internal Server Error', 500));   // PUT → fails
    const client = await buildClient();
    const result = await client.callTool({ name: 'set_user_memory', arguments: { key: 'lang', value: 'Go' } }) as ErrorResult;
    expect(result.isError).toBe(true);
  });
});

// ── Additional happy-path coverage ───────────────────────────────────────────

describe('get_service_metrics — custom metric', () => {
  it('uses the provided metric name in the Prometheus query URL', async () => {
    fetchMock().mockResolvedValueOnce(makeResponse({ data: { result: [] } }));
    const client = await buildClient();
    await client.callTool({ name: 'get_service_metrics', arguments: { service_name: 'svc', metric: 'custom_counter_total' } });
    const url = fetchMock().mock.calls[0][0] as string;
    expect(url).toContain('custom_counter_total');
    expect(url).toContain('svc');
  });
});

describe('scaffold_service — task failure', () => {
  it('returns status:failed when scaffolder task fails', async () => {
    fetchMock()
      .mockResolvedValueOnce(makeResponse({ id: 'task-failed' }, 201))
      .mockResolvedValueOnce(makeResponse({ status: 'failed', output: null }));
    const client = await buildClient();
    const result = await client.callTool({
      name: 'scaffold_service',
      arguments: { template_ref: 'template:default/svc', values: { name: 'svc', owner: 'team', repoUrl: 'github.com?owner=o&repo=r' } },
    });
    const parsed = parseResult(result as Parameters<typeof parseResult>[0]) as { status: string; task_id: string };
    expect(parsed.status).toBe('failed');
    expect(parsed.task_id).toBe('task-failed');
  });
});

describe('set_user_memory — corrupted preferences JSON', () => {
  it('resets preferences to {} when stored JSON is malformed', async () => {
    fetchMock()
      .mockResolvedValueOnce(makeResponse({ data: { preferences: 'not-valid-json{{' } })) // GET → bad JSON
      .mockResolvedValueOnce(makeResponse({})); // POST
    const client = await buildClient();
    const result = await client.callTool({ name: 'set_user_memory', arguments: { key: 'lang', value: 'Go' } });
    const parsed = parseResult(result as Parameters<typeof parseResult>[0]) as { updated: { lang: string } };
    expect(parsed.updated.lang).toBe('Go');
  });
});

describe('list_templates — title fallback', () => {
  it('uses metadata.name as title when title field is absent', async () => {
    fetchMock().mockResolvedValueOnce(makeResponse([
      { metadata: { name: 'my-template' }, spec: { type: 'service' } }, // no title
    ]));
    const client = await buildClient();
    const result = await client.callTool({ name: 'list_templates', arguments: {} });
    const parsed = parseResult(result as Parameters<typeof parseResult>[0]) as Array<{ title: string }>;
    expect(parsed[0].title).toBe('my-template');
  });
});

describe('list_deployments — missing readyReplicas defaults to 0', () => {
  it('sets ready_replicas to 0 when field is absent from K8s status', async () => {
    fetchMock().mockResolvedValueOnce(makeResponse({
      items: [{
        metadata: { name: 'svc', namespace: 'services' },
        spec: { replicas: 1, template: { spec: { containers: [{ image: 'img:v1' }] } } },
        status: {}, // no readyReplicas
      }],
    }));
    const client = await buildClient();
    const result = await client.callTool({ name: 'list_deployments', arguments: { namespace: 'services' } });
    const parsed = parseResult(result as Parameters<typeof parseResult>[0]) as Array<{ ready_replicas: number }>;
    expect(parsed[0].ready_replicas).toBe(0);
  });
});
