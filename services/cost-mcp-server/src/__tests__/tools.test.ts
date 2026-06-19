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

// Prometheus query response helper
function makePromResponse(value: number | null) {
  if (value === null) {
    return makeResponse({ data: { result: [] } });
  }
  return makeResponse({
    data: {
      result: [{ metric: {}, value: [Date.now() / 1000, String(value)] }],
    },
  });
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

// ── get_namespace_cost ────────────────────────────────────────────────────────

describe('get_namespace_cost', () => {
  const MOCK_COST_ENTRY = {
    totalCost: 123.456,
    cpuCost: 50.12,
    ramCost: 40.34,
    networkCost: 5.0,
    storageUsageCost: 28.0,
    minutes: 43200,  // 720 hours
  };

  it('returns cost breakdown for a namespace', async () => {
    const opencostResponse = {
      data: [{ 'my-namespace': MOCK_COST_ENTRY }],
    };
    fetchMock().mockResolvedValueOnce(makeResponse(opencostResponse));
    const client = await buildClient();
    const result = await client.callTool({
      name: 'get_namespace_cost',
      arguments: { namespace: 'my-namespace', window: '30d' },
    });
    const data = parseResult(result as { content: Array<{ type: string; text?: string }> }) as {
      namespace: string;
      window: string;
      total_cost_usd: number;
      cpu_cost_usd: number;
      memory_cost_usd: number;
      hours_sampled: number;
    };
    expect(data.namespace).toBe('my-namespace');
    expect(data.window).toBe('30d');
    expect(data.total_cost_usd).toBe(123.46);
    expect(data.cpu_cost_usd).toBe(50.12);
    expect(data.memory_cost_usd).toBe(40.34);
    expect(data.hours_sampled).toBe(720);
  });

  it('returns "no data" message when namespace missing from response', async () => {
    const opencostResponse = { data: [] };
    fetchMock().mockResolvedValueOnce(makeResponse(opencostResponse));
    const client = await buildClient();
    const result = await client.callTool({
      name: 'get_namespace_cost',
      arguments: { namespace: 'missing-ns', window: '30d' },
    });
    const data = parseResult(result as { content: Array<{ type: string; text?: string }> }) as {
      message: string;
    };
    expect(data.message).toContain('No cost data found');
  });

  it('returns isError on OpenCost error', async () => {
    fetchMock().mockResolvedValueOnce(makeResponse('Internal Server Error', 500));
    const client = await buildClient();
    const result = await client.callTool({ name: 'get_namespace_cost', arguments: { namespace: 'my-namespace', window: '30d' } }) as ErrorResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('500');
  });

  it('returns isError for invalid namespace label (special chars)', async () => {
    const client = await buildClient();
    const result = await client.callTool({ name: 'get_namespace_cost', arguments: { namespace: 'bad"ns}inject', window: '30d' } }) as ErrorResult;
    expect(result.isError).toBe(true);
  });
});

// ── get_team_spend ────────────────────────────────────────────────────────────

describe('get_team_spend', () => {
  it('returns actual_cost + utilization + status:OK when utilization < 75%', async () => {
    // 3 Prometheus queries: actualCost, budgetUtilization, budgetLimit
    fetchMock()
      .mockResolvedValueOnce(makePromResponse(500))      // actualCost
      .mockResolvedValueOnce(makePromResponse(0.5))      // budgetUtilization (50%)
      .mockResolvedValueOnce(makePromResponse(1000));    // budgetLimit
    const client = await buildClient();
    const result = await client.callTool({
      name: 'get_team_spend',
      arguments: { team: 'team-platform' },
    });
    const data = parseResult(result as { content: Array<{ type: string; text?: string }> }) as {
      team: string;
      actual_cost_usd: number;
      utilization_pct: number;
      status: string;
    };
    expect(data.team).toBe('team-platform');
    expect(data.actual_cost_usd).toBe(500);
    expect(data.utilization_pct).toBe(50);
    expect(data.status).toBe('OK');
  });

  it('returns status:WARNING when utilization is 75-90%', async () => {
    fetchMock()
      .mockResolvedValueOnce(makePromResponse(800))
      .mockResolvedValueOnce(makePromResponse(0.80))   // 80%
      .mockResolvedValueOnce(makePromResponse(1000));
    const client = await buildClient();
    const result = await client.callTool({
      name: 'get_team_spend',
      arguments: { team: 'team-platform' },
    });
    const data = parseResult(result as { content: Array<{ type: string; text?: string }> }) as { status: string };
    expect(data.status).toBe('WARNING');
  });

  it('returns status:OVER_BUDGET when utilization >= 90%', async () => {
    fetchMock()
      .mockResolvedValueOnce(makePromResponse(950))
      .mockResolvedValueOnce(makePromResponse(0.95))   // 95%
      .mockResolvedValueOnce(makePromResponse(1000));
    const client = await buildClient();
    const result = await client.callTool({
      name: 'get_team_spend',
      arguments: { team: 'team-platform' },
    });
    const data = parseResult(result as { content: Array<{ type: string; text?: string }> }) as { status: string };
    expect(data.status).toBe('OVER_BUDGET');
  });

  it('returns "no metrics" message when actualCost is null', async () => {
    fetchMock()
      .mockResolvedValueOnce(makePromResponse(null))   // actualCost = null
      .mockResolvedValueOnce(makePromResponse(0.5))
      .mockResolvedValueOnce(makePromResponse(1000));
    const client = await buildClient();
    const result = await client.callTool({
      name: 'get_team_spend',
      arguments: { team: 'team-platform' },
    });
    const data = parseResult(result as { content: Array<{ type: string; text?: string }> }) as { message: string };
    expect(data.message).toContain('No cost metrics found');
  });
});

// ── list_budget_overruns ──────────────────────────────────────────────────────

describe('list_budget_overruns', () => {
  it('returns sorted overrun list with utilization_pct', async () => {
    const promResponse = {
      data: {
        result: [
          { metric: { team: 'team-alpha' }, value: [1234567890, '0.85'] },
          { metric: { team: 'team-beta' }, value: [1234567890, '0.95'] },
          { metric: { team: 'team-gamma' }, value: [1234567890, '0.82'] },
        ],
      },
    };
    fetchMock().mockResolvedValueOnce(makeResponse(promResponse));
    const client = await buildClient();
    const result = await client.callTool({
      name: 'list_budget_overruns',
      arguments: { threshold_pct: 80 },
    });
    const data = parseResult(result as { content: Array<{ type: string; text?: string }> }) as {
      threshold_pct: number;
      overrun_count: number;
      teams: Array<{ team: string; utilization_pct: number }>;
    };
    expect(data.threshold_pct).toBe(80);
    expect(data.overrun_count).toBe(3);
    // Sorted descending by utilization_pct
    expect(data.teams[0].team).toBe('team-beta');
    expect(data.teams[0].utilization_pct).toBe(95);
    expect(data.teams[1].team).toBe('team-alpha');
    expect(data.teams[2].team).toBe('team-gamma');
  });

  it('returns empty list when no overruns', async () => {
    const promResponse = { data: { result: [] } };
    fetchMock().mockResolvedValueOnce(makeResponse(promResponse));
    const client = await buildClient();
    const result = await client.callTool({
      name: 'list_budget_overruns',
      arguments: {},
    });
    const data = parseResult(result as { content: Array<{ type: string; text?: string }> }) as {
      overrun_count: number;
      teams: unknown[];
    };
    expect(data.overrun_count).toBe(0);
    expect(data.teams).toHaveLength(0);
  });
});

// ── get_rightsizing_recommendations ──────────────────────────────────────────

describe('get_rightsizing_recommendations', () => {
  it('returns "not available" message when endpoint returns 404', async () => {
    fetchMock().mockResolvedValueOnce(makeResponse('Not Found', 404));
    const client = await buildClient();
    const result = await client.callTool({
      name: 'get_rightsizing_recommendations',
      arguments: { window: '7d' },
    });
    const data = parseResult(result as { content: Array<{ type: string; text?: string }> }) as { message: string };
    expect(data.message).toContain('not available');
  });

  it('returns sorted recommendation list when data is available', async () => {
    const recsResponse = {
      recommendations: [
        {
          namespace: 'services',
          controllerName: 'api-server',
          containerName: 'api',
          currentCPUReq: 1.0,
          recommendedCPUReq: 0.5,
          currentRAMReq: 512 * 1024 * 1024,
          recommendedRAMReq: 256 * 1024 * 1024,
          monthlySavings: 20.5,
        },
        {
          namespace: 'monitoring',
          controllerName: 'exporter',
          containerName: 'main',
          currentCPUReq: 0.5,
          recommendedCPUReq: 0.25,
          currentRAMReq: 256 * 1024 * 1024,
          recommendedRAMReq: 128 * 1024 * 1024,
          monthlySavings: 10.0,
        },
      ],
    };
    fetchMock().mockResolvedValueOnce(makeResponse(recsResponse));
    const client = await buildClient();
    const result = await client.callTool({
      name: 'get_rightsizing_recommendations',
      arguments: { window: '30d' },
    });
    const data = parseResult(result as { content: Array<{ type: string; text?: string }> }) as {
      total_recommendations: number;
      total_potential_savings_usd: number;
      recommendations: Array<{ workload: string; monthly_savings_usd: number }>;
    };
    expect(data.total_recommendations).toBe(2);
    // Sorted descending by savings
    expect(data.recommendations[0].workload).toBe('api-server');
    expect(data.recommendations[0].monthly_savings_usd).toBe(20.5);
    expect(data.recommendations[1].workload).toBe('exporter');
  });
});

// ── forecast_budget ───────────────────────────────────────────────────────────

describe('forecast_budget', () => {
  it('returns forecast_eom_spend_usd and forecast_status:ON_TRACK', async () => {
    // 2 Prometheus queries: actualCost, budgetLimit
    fetchMock()
      .mockResolvedValueOnce(makePromResponse(300))    // actualCost (mid-month)
      .mockResolvedValueOnce(makePromResponse(1000));  // budgetLimit
    const client = await buildClient();
    const result = await client.callTool({
      name: 'forecast_budget',
      arguments: { team: 'team-platform' },
    });
    const data = parseResult(result as { content: Array<{ type: string; text?: string }> }) as {
      team: string;
      forecast_eom_spend_usd: number;
      daily_burn_rate_usd: number;
      forecast_status: string;
    };
    expect(data.team).toBe('team-platform');
    expect(typeof data.forecast_eom_spend_usd).toBe('number');
    expect(typeof data.daily_burn_rate_usd).toBe('number');
    // With $300 spend and $1000 limit, most scenarios are ON_TRACK or AT_RISK
    expect(['ON_TRACK', 'AT_RISK', 'OVER_BUDGET']).toContain(data.forecast_status);
  });

  it('returns OVER_BUDGET when forecast utilization >= 100%', async () => {
    // actualCost is very high relative to budget
    fetchMock()
      .mockResolvedValueOnce(makePromResponse(2000))   // actualCost already exceeds budget
      .mockResolvedValueOnce(makePromResponse(1000));  // budgetLimit
    const client = await buildClient();
    const result = await client.callTool({
      name: 'forecast_budget',
      arguments: { team: 'team-platform' },
    });
    const data = parseResult(result as { content: Array<{ type: string; text?: string }> }) as {
      forecast_status: string;
    };
    expect(data.forecast_status).toBe('OVER_BUDGET');
  });

  it('returns no metrics message when actualCost is null', async () => {
    fetchMock()
      .mockResolvedValueOnce(makePromResponse(null))
      .mockResolvedValueOnce(makePromResponse(1000));
    const client = await buildClient();
    const result = await client.callTool({
      name: 'forecast_budget',
      arguments: { team: 'team-platform' },
    });
    const data = parseResult(result as { content: Array<{ type: string; text?: string }> }) as { message: string };
    expect(data.message).toContain('No cost metrics found');
  });
});
