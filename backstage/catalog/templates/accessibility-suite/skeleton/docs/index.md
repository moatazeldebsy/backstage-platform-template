# ${{ values.name }}

${{ values.description }}

## Overview

Axe-core + Playwright accessibility test suite for **${{ values.targetService }}**.

| Parameter | Value |
|-----------|-------|
| Base URL | `${{ values.baseUrl }}` |
| WCAG Level | `${{ values.wcagLevel }}` |

## What is tested

Every page listed in `tests/a11y.spec.ts` is scanned with axe-core against the configured WCAG ruleset. Any violation causes the test to fail with a detailed report of the affected element, the rule, and a remediation link.

## Running locally

```bash
npm install
npx playwright install chromium --with-deps
npm test
npx playwright show-report
```

## Adding pages

Add a new `test()` block in `tests/a11y.spec.ts`:

```typescript
test('login page has no violations', async ({ page }) => {
  await page.goto('/login');
  const results = await new AxeBuilder({ page })
    .withTags(['${{ values.wcagLevel }}'])
    .analyze();
  expect(results.violations).toEqual([]);
});
```
