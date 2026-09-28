import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.describe('${{ values.targetService }} accessibility (${{ values.wcagLevel }})', () => {
  test('homepage has no violations', async ({ page }) => {
    await page.goto('/');
    const results = await new AxeBuilder({ page })
      .withTags(['${{ values.wcagLevel }}'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
