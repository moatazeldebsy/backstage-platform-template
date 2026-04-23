import { test, expect } from '@playwright/test';

test.describe('Smoke — health probes', () => {
  test('GET /healthz returns 200', async ({ request }) => {
    const res = await request.get('/healthz');
    expect(res.status()).toBe(200);
  });

  test('GET /ready returns 200', async ({ request }) => {
    const res = await request.get('/ready');
    expect(res.status()).toBe(200);
  });

  test('/healthz body contains status ok', async ({ request }) => {
    const res = await request.get('/healthz');
    const body = await res.json();
    expect(body).toHaveProperty('status');
    expect(['ok', 'healthy']).toContain(body.status);
  });
});

test.describe('Smoke — metrics', () => {
  test('GET /metrics returns Prometheus text', async ({ request }) => {
    const res = await request.get('/metrics');
    // Some services may not expose /metrics — skip gracefully
    if (res.status() === 404) test.skip();
    expect(res.status()).toBe(200);
    const text = await res.text();
    expect(text).toContain('# HELP');
  });
});
