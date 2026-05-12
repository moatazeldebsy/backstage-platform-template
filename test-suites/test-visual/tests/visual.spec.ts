import { test, expect } from '@playwright/test';

test.describe('hello-service visual snapshots', () => {
  test('homepage matches snapshot', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveScreenshot('homepage.png', { fullPage: true });
  });
});
