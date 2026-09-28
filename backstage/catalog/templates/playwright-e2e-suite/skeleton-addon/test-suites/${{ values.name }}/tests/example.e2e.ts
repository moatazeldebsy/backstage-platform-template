import { test, expect } from './fixtures/base.fixture';

test.describe('${{ values.targetService }} smoke tests', () => {
  test('homepage loads', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/.+/);
  });

  test('health endpoint returns 200', async ({ request }) => {
    const response = await request.get('/healthz');
    expect(response.status()).toBe(200);
  });
});
