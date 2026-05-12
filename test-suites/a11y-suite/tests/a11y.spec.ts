import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.describe('hello-service accessibility (wcag21aa)', () => {
  test('homepage has no violations', async ({ page }) => {
    await page.goto('/');
    const results = await new AxeBuilder({ page })
      .withTags(['wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
