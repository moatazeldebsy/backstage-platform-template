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
  return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) };
}

async function buildClient() {
  const server = createServer('security-agent');
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

describe('list_vulnerable_deps', () => {
  it('lists open Dependabot alerts', async () => {
    const mockAlerts = [
      {
        number: 5,
        security_advisory: { summary: 'Prototype pollution', severity: 'high', cve_id: 'CVE-2026-1234' },
        dependency: { package: { name: 'lodash', ecosystem: 'npm' } },
        html_url: 'https://github.com/org/my-service/security/dependabot/5',
      },
    ];
    fetchMock().mockResolvedValueOnce(makeResponse(mockAlerts));
    const client = await buildClient();
    const result = await client.callTool({ name: 'list_vulnerable_deps', arguments: { repo: 'org/my-service' } });
    const data = parseResult(result as Parameters<typeof parseResult>[0]) as { total: number; alerts: Array<{ package: string; severity: string }> };
    expect(data.total).toBe(1);
    expect(data.alerts[0].package).toBe('lodash');
    expect(data.alerts[0].severity).toBe('high');
  });

  it('filters by severity', async () => {
    fetchMock().mockResolvedValueOnce(makeResponse([]));
    const client = await buildClient();
    await client.callTool({ name: 'list_vulnerable_deps', arguments: { repo: 'org/my-service', severity: 'critical' } });
    const calledUrl: string = fetchMock().mock.calls[0][0];
    expect(calledUrl).toContain('severity=critical');
  });

  it('returns isError on GitHub API error', async () => {
    fetchMock().mockResolvedValueOnce(makeResponse('Forbidden', 403));
    const client = await buildClient();
    const result = await client.callTool({ name: 'list_vulnerable_deps', arguments: { repo: 'org/my-service' } }) as ErrorResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('403');
  });
});

describe('get_secret_rotation_status', () => {
  it('lists open secret-rotation issues', async () => {
    const mockIssues = [
      { number: 12, title: 'Rotate secret: DATABASE_URL (my-service)', html_url: 'https://github.com/org/my-service/issues/12', created_at: '2026-07-01T00:00:00Z' },
    ];
    fetchMock().mockResolvedValueOnce(makeResponse(mockIssues));
    const client = await buildClient();
    const result = await client.callTool({ name: 'get_secret_rotation_status', arguments: { repo: 'org/my-service' } });
    const data = parseResult(result as Parameters<typeof parseResult>[0]) as { pending_rotations: number };
    expect(data.pending_rotations).toBe(1);
    const calledUrl: string = fetchMock().mock.calls[0][0];
    expect(calledUrl).toContain('labels=secret-rotation');
  });

  it('returns isError on GitHub API error', async () => {
    fetchMock().mockResolvedValueOnce(makeResponse('Not Found', 404));
    const client = await buildClient();
    const result = await client.callTool({ name: 'get_secret_rotation_status', arguments: { repo: 'org/my-service' } }) as ErrorResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('404');
  });
});

describe('list_policy_violations', () => {
  it('flattens failed results across policy reports', async () => {
    const mockReports = {
      items: [
        {
          metadata: { name: 'polr-ns-services', namespace: 'services' },
          results: [
            { policy: 'require-team-label', rule: 'check-label', result: 'fail', resources: [{ kind: 'Deployment', name: 'hello-service' }], message: 'missing idp:team label' },
            { policy: 'require-team-label', rule: 'check-label', result: 'pass', resources: [{ kind: 'Deployment', name: 'other-service' }] },
          ],
        },
      ],
    };
    fetchMock().mockResolvedValueOnce(makeResponse(mockReports));
    const client = await buildClient();
    const result = await client.callTool({ name: 'list_policy_violations', arguments: {} });
    const data = parseResult(result as Parameters<typeof parseResult>[0]) as { total: number; violations: Array<{ policy: string; namespace: string }> };
    expect(data.total).toBe(1);
    expect(data.violations[0].policy).toBe('require-team-label');
    expect(data.violations[0].namespace).toBe('services');
  });

  it('queries the namespaced endpoint when namespace is provided', async () => {
    fetchMock().mockResolvedValueOnce(makeResponse({ items: [] }));
    const client = await buildClient();
    await client.callTool({ name: 'list_policy_violations', arguments: { namespace: 'services-dev' } });
    const calledUrl: string = fetchMock().mock.calls[0][0];
    expect(calledUrl).toContain('/namespaces/services-dev/policyreports');
  });

  it('returns isError on Kubernetes API error', async () => {
    fetchMock().mockResolvedValueOnce(makeResponse('Forbidden', 403));
    const client = await buildClient();
    const result = await client.callTool({ name: 'list_policy_violations', arguments: {} }) as ErrorResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('403');
  });
});
