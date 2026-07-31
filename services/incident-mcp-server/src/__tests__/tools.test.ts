import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

jest.mock('node-fetch', () => {
  const mockFetch = jest.fn();
  return { default: mockFetch, __esModule: true };
});

process.env.INCIDENT_REPO = 'org/my-service';
process.env.GITHUB_TOKEN = 'test-token';
process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.example/webhook';

// Imported after env vars are set, since server.ts reads them at module load time.
import { createServer } from '../server.js';

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

// ── get_open_incidents ───────────────────────────────────────────────────────

describe('get_open_incidents', () => {
  it('lists open incidents from tracked GitHub issues', async () => {
    const mockIssues = [
      { number: 101, title: '[INCIDENT] HighErrorRate — hello-service (INC-1)', html_url: 'https://github.com/org/my-service/issues/101', created_at: '2026-07-01T00:00:00Z', labels: ['incident', 'incident:open', 'severity:critical'] },
    ];
    fetchMock().mockResolvedValueOnce(makeResponse(mockIssues));
    const client = await buildClient();
    const result = await client.callTool({ name: 'get_open_incidents', arguments: {} });
    const data = parseResult(result as { content: Array<{ type: string; text?: string }> }) as { total: number; incidents: Array<{ issue_number: number }> };
    expect(data.total).toBe(1);
    expect(data.incidents[0].issue_number).toBe(101);
    const calledUrl: string = fetchMock().mock.calls[0][0];
    expect(calledUrl).toContain('labels=incident%3Aopen');
  });

  it('filters by severity when provided', async () => {
    fetchMock().mockResolvedValueOnce(makeResponse([]));
    const client = await buildClient();
    await client.callTool({ name: 'get_open_incidents', arguments: { severity: 'critical' } });
    const calledUrl: string = fetchMock().mock.calls[0][0];
    expect(calledUrl).toContain('severity%3Acritical');
  });

  it('returns isError on GitHub API error', async () => {
    fetchMock().mockResolvedValueOnce(makeResponse('Forbidden', 403));
    const client = await buildClient();
    const result = await client.callTool({ name: 'get_open_incidents', arguments: {} }) as ErrorResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('403');
  });
});

// ── get_alert_history ────────────────────────────────────────────────────────

describe('get_alert_history', () => {
  it('summarizes Prometheus ALERTS range results', async () => {
    const mockRange = {
      data: {
        result: [
          {
            metric: { alertname: 'HighErrorRate', severity: 'critical', namespace: 'services', alertstate: 'firing' },
            values: [[1751328000, '1'], [1751328300, '1']],
          },
        ],
      },
    };
    fetchMock().mockResolvedValueOnce(makeResponse(mockRange));
    const client = await buildClient();
    const result = await client.callTool({ name: 'get_alert_history', arguments: { hours: 24 } });
    const data = parseResult(result as { content: Array<{ type: string; text?: string }> }) as { total: number; alerts: Array<{ alertname: string; sample_count: number }> };
    expect(data.total).toBe(1);
    expect(data.alerts[0].alertname).toBe('HighErrorRate');
    expect(data.alerts[0].sample_count).toBe(2);
  });

  it('returns isError on Prometheus API error', async () => {
    fetchMock().mockResolvedValueOnce(makeResponse('Bad Gateway', 502));
    const client = await buildClient();
    const result = await client.callTool({ name: 'get_alert_history', arguments: {} }) as ErrorResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('502');
  });
});

// ── get_runbook ───────────────────────────────────────────────────────────────

describe('get_runbook', () => {
  it('fetches and base64-decodes a runbook file', async () => {
    const content = Buffer.from('# Runbook\nDo the thing.').toString('base64');
    fetchMock().mockResolvedValueOnce(makeResponse({ content, encoding: 'base64' }));
    const client = await buildClient();
    const result = await client.callTool({ name: 'get_runbook', arguments: { name: 'kagent-guardrails' } });
    const data = parseResult(result as { content: Array<{ type: string; text?: string }> }) as { found: boolean; content: string };
    expect(data.found).toBe(true);
    expect(data.content).toContain('Do the thing.');
  });

  it('lists available runbooks when the requested one is not found', async () => {
    fetchMock()
      .mockResolvedValueOnce(makeResponse('Not Found', 404))
      .mockResolvedValueOnce(makeResponse([{ name: 'kagent-guardrails.md' }, { name: 'dr-region-failover.md' }]));
    const client = await buildClient();
    const result = await client.callTool({ name: 'get_runbook', arguments: { name: 'does-not-exist' } });
    const data = parseResult(result as { content: Array<{ type: string; text?: string }> }) as { found: boolean; available_runbooks: string[] };
    expect(data.found).toBe(false);
    expect(data.available_runbooks).toContain('kagent-guardrails');
  });
});

// ── post_incident_update ─────────────────────────────────────────────────────

describe('post_incident_update', () => {
  it('posts a comment on the incident issue', async () => {
    const mockComment = { id: 999, html_url: 'https://github.com/org/my-service/issues/101#issuecomment-999' };
    fetchMock().mockResolvedValueOnce(makeResponse(mockComment));
    const client = await buildClient();
    const result = await client.callTool({
      name: 'post_incident_update',
      arguments: { issue_number: 101, body: 'Mitigation applied.' },
    });
    const data = parseResult(result as { content: Array<{ type: string; text?: string }> }) as { posted: boolean; comment_id: number };
    expect(data.posted).toBe(true);
    expect(data.comment_id).toBe(999);
  });

  it('returns isError on GitHub API error', async () => {
    fetchMock().mockResolvedValueOnce(makeResponse('Forbidden', 403));
    const client = await buildClient();
    const result = await client.callTool({
      name: 'post_incident_update',
      arguments: { issue_number: 101, body: 'update' },
    }) as ErrorResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('403');
  });
});

// ── send_notification ────────────────────────────────────────────────────────

describe('send_notification', () => {
  it('POSTs to the configured Slack webhook', async () => {
    fetchMock().mockResolvedValueOnce(makeResponse({ ok: true }));
    const client = await buildClient();
    const result = await client.callTool({ name: 'send_notification', arguments: { message: 'Incident mitigated' } });
    const data = parseResult(result as { content: Array<{ type: string; text?: string }> }) as { sent: boolean };
    expect(data.sent).toBe(true);
    const calledInit = fetchMock().mock.calls[0][1];
    expect(JSON.parse(calledInit.body as string).text).toBe('Incident mitigated');
  });

  it('returns isError on webhook error', async () => {
    fetchMock().mockResolvedValueOnce(makeResponse('Bad Gateway', 502));
    const client = await buildClient();
    const result = await client.callTool({ name: 'send_notification', arguments: { message: 'test' } }) as ErrorResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('502');
  });
});
