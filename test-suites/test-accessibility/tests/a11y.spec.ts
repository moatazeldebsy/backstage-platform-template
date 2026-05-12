import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.describe('hello-service accessibility (wcag2aa)', () => {
  test('homepage has no violations', async ({ page }) => {
    await page.goto('/');
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
