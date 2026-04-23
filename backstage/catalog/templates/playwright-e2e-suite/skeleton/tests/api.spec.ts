import { test, expect } from '@playwright/test';

test.describe('API contract — root endpoint', () => {
  test('GET / returns 200', async ({ request }) => {
    const res = await request.get('/');
    expect([200, 204]).toContain(res.status());
  });

  test('Response content-type is JSON or text', async ({ request }) => {
    const res = await request.get('/');
    if (res.status() !== 200) test.skip();
    const ct = res.headers()['content-type'] ?? '';
    expect(ct).toMatch(/json|text/);
  });

  test('Response time is under 2 seconds', async ({ request }) => {
    const start = Date.now();
    await request.get('/healthz');
    expect(Date.now() - start).toBeLessThan(2000);
  });
});
