import request from 'supertest';

jest.mock('../store.js', () => ({
  createApproval: jest.fn(),
  getApproval: jest.fn(),
  listApprovals: jest.fn(),
  decideApproval: jest.fn(),
  initSchema: jest.fn(),
}));

import {
  createApp,
  initSchemaWithRetry,
  isSchemaReady,
  markSchemaFailed,
  markSchemaReady,
} from '../app.js';
import { initSchema } from '../store.js';

const mockInitSchema = initSchema as jest.Mock;

beforeEach(() => {
  jest.resetAllMocks();
  markSchemaFailed(new Error('reset'));
});

describe('liveness is independent of the database', () => {
  it('serves /healthz while the schema is uninitialised', async () => {
    // The whole point: Postgres being absent must not look like a dead process,
    // because the kubelet would then kill and restart the container forever.
    const res = await request(createApp()).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('still serves /healthz after the schema is ready', async () => {
    markSchemaReady();
    const res = await request(createApp()).get('/healthz');
    expect(res.status).toBe(200);
  });
});

describe('readiness reflects the database', () => {
  it('returns 503 with a reason before the schema exists', async () => {
    markSchemaFailed(new Error('getaddrinfo EAI_AGAIN host.docker.internal'));
    const res = await request(createApp()).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not-ready');
    expect(res.body.error).toContain('EAI_AGAIN');
  });

  it('returns 200 once the schema is ready', async () => {
    markSchemaReady();
    const res = await request(createApp()).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
  });

  it('flips back to 503 if a later init fails', async () => {
    markSchemaReady();
    markSchemaFailed(new Error('connection terminated'));
    const res = await request(createApp()).get('/ready');
    expect(res.status).toBe(503);
  });
});

describe('initSchemaWithRetry', () => {
  // Records the requested backoff without ever sleeping, so these tests are
  // deterministic rather than depending on real timers under load.
  function recordingSleep() {
    const delays: number[] = [];
    return { delays, sleep: async (ms: number) => { delays.push(ms); } };
  }

  it('marks ready on first success', async () => {
    mockInitSchema.mockResolvedValueOnce(undefined);
    await expect(initSchemaWithRetry({ attempts: 1 })).resolves.toBe(true);
    expect(isSchemaReady()).toBe(true);
    expect(mockInitSchema).toHaveBeenCalledTimes(1);
  });

  it('retries until it succeeds, then marks ready', async () => {
    mockInitSchema
      .mockRejectedValueOnce(new Error('EAI_AGAIN'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(undefined);
    await expect(initSchemaWithRetry({ attempts: 5, delayMs: 1, sleep: recordingSleep().sleep })).resolves.toBe(true);
    expect(mockInitSchema).toHaveBeenCalledTimes(3);
    expect(isSchemaReady()).toBe(true);
  });

  it('gives up after the attempt budget and stays unready', async () => {
    mockInitSchema.mockRejectedValue(new Error('EAI_AGAIN'));
    await expect(initSchemaWithRetry({ attempts: 3, delayMs: 1, sleep: recordingSleep().sleep })).resolves.toBe(false);
    expect(mockInitSchema).toHaveBeenCalledTimes(3);
    expect(isSchemaReady()).toBe(false);
  });

  it('does not throw when the database never comes up', async () => {
    // The failure this replaces was an unhandled rejection reaching
    // process.exit(1) in index.ts.
    mockInitSchema.mockRejectedValue(new Error('EAI_AGAIN'));
    await expect(initSchemaWithRetry({ attempts: 2, delayMs: 1, sleep: recordingSleep().sleep })).resolves.toBe(false);
  });

  it('backs off linearly and caps the delay', async () => {
    const { delays, sleep } = recordingSleep();
    mockInitSchema.mockRejectedValue(new Error('EAI_AGAIN'));
    await initSchemaWithRetry({ attempts: 5, delayMs: 10, maxDelayMs: 25, sleep });

    // attempt 1..4 sleep (the 5th exhausts the budget and returns instead):
    // 10, 20, 30->25, 40->25
    expect(delays).toEqual([10, 20, 25, 25]);
  });
});
