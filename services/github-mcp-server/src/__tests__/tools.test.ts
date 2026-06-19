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

// ── get_pr_diff ───────────────────────────────────────────────────────────────

describe('get_pr_diff', () => {
  const MOCK_FILES = [
    { filename: 'src/main.ts', status: 'modified', additions: 10, deletions: 2, patch: '@@ ...' },
    { filename: 'src/utils.ts', status: 'added', additions: 30, deletions: 0 },
  ];

  it('returns changed file list with total count', async () => {
    fetchMock().mockResolvedValueOnce(makeResponse(MOCK_FILES));
    const client = await buildClient();
    const result = await client.callTool({
      name: 'get_pr_diff',
      arguments: { repo: 'org/my-service', pr_number: 42 },
    });
    const data = parseResult(result as { content: Array<{ type: string; text?: string }> }) as {
      repo: string;
      pr_number: number;
      total: number;
      changed_files: Array<{ filename: string; status: string }>;
    };
    expect(data.repo).toBe('org/my-service');
    expect(data.pr_number).toBe(42);
    expect(data.total).toBe(2);
    expect(data.changed_files[0].filename).toBe('src/main.ts');
    expect(data.changed_files[0].status).toBe('modified');
    expect(data.changed_files[1].filename).toBe('src/utils.ts');
  });

  it('returns isError on GitHub API error', async () => {
    fetchMock().mockResolvedValueOnce(makeResponse('Not Found', 404));
    const client = await buildClient();
    const result = await client.callTool({ name: 'get_pr_diff', arguments: { repo: 'org/my-service', pr_number: 99 } }) as ErrorResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('404');
  });
});

// ── add_pr_comment ────────────────────────────────────────────────────────────

describe('add_pr_comment', () => {
  it('POSTs to /issues/:pr/comments and returns comment_id and url', async () => {
    const mockComment = { id: 12345, html_url: 'https://github.com/org/my-service/issues/42#issuecomment-12345' };
    fetchMock().mockResolvedValueOnce(makeResponse(mockComment));
    const client = await buildClient();
    const result = await client.callTool({
      name: 'add_pr_comment',
      arguments: { repo: 'org/my-service', pr_number: 42, body: '## Test Results\nAll tests passed!' },
    });
    const data = parseResult(result as { content: Array<{ type: string; text?: string }> }) as {
      comment_id: number;
      url: string;
    };
    expect(data.comment_id).toBe(12345);
    expect(data.url).toContain('github.com');

    // Verify it called the issues endpoint (not pulls endpoint)
    const calledUrl: string = fetchMock().mock.calls[0][0];
    expect(calledUrl).toContain('/issues/42/comments');
    const calledInit = fetchMock().mock.calls[0][1];
    expect(calledInit.method).toBe('POST');
  });

  it('returns isError on GitHub API error', async () => {
    fetchMock().mockResolvedValueOnce(makeResponse('Forbidden', 403));
    const client = await buildClient();
    const result = await client.callTool({
      name: 'add_pr_comment',
      arguments: { repo: 'org/my-service', pr_number: 42, body: 'comment' },
    }) as ErrorResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('403');
  });
});

// ── get_ci_status ─────────────────────────────────────────────────────────────

describe('get_ci_status', () => {
  const MOCK_PR = { head: { sha: 'deadbeef1234' } };

  it('all_passed=true when all checks succeed', async () => {
    const mockChecks = {
      check_runs: [
        { name: 'unit-tests', status: 'completed', conclusion: 'success' },
        { name: 'lint', status: 'completed', conclusion: 'success' },
      ],
    };
    fetchMock()
      .mockResolvedValueOnce(makeResponse(MOCK_PR))
      .mockResolvedValueOnce(makeResponse(mockChecks));
    const client = await buildClient();
    const result = await client.callTool({
      name: 'get_ci_status',
      arguments: { repo: 'org/my-service', pr_number: 42 },
    });
    const data = parseResult(result as { content: Array<{ type: string; text?: string }> }) as {
      sha: string;
      all_passed: boolean;
      failed_checks: unknown[];
    };
    expect(data.sha).toBe('deadbeef1234');
    expect(data.all_passed).toBe(true);
    expect(data.failed_checks).toHaveLength(0);
  });

  it('all_passed=false with failed_checks when any check fails', async () => {
    const mockChecks = {
      check_runs: [
        { name: 'unit-tests', status: 'completed', conclusion: 'success' },
        { name: 'integration', status: 'completed', conclusion: 'failure' },
      ],
    };
    fetchMock()
      .mockResolvedValueOnce(makeResponse(MOCK_PR))
      .mockResolvedValueOnce(makeResponse(mockChecks));
    const client = await buildClient();
    const result = await client.callTool({
      name: 'get_ci_status',
      arguments: { repo: 'org/my-service', pr_number: 42 },
    });
    const data = parseResult(result as { content: Array<{ type: string; text?: string }> }) as {
      all_passed: boolean;
      failed_checks: Array<{ name: string; conclusion: string }>;
    };
    expect(data.all_passed).toBe(false);
    expect(data.failed_checks).toHaveLength(1);
    expect(data.failed_checks[0].name).toBe('integration');
  });

  it('returns isError on PR fetch error', async () => {
    fetchMock().mockResolvedValueOnce(makeResponse('Not Found', 404));
    const client = await buildClient();
    const result = await client.callTool({ name: 'get_ci_status', arguments: { repo: 'org/my-service', pr_number: 999 } }) as ErrorResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('404');
  });
});
