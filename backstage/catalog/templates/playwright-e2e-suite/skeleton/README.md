# ${{ values.name }}

${{ values.description }}

Playwright E2E test suite targeting `${{ values.targetService }}`.

## Quick start

```bash
npm install
npx playwright install --with-deps
npx playwright test
npx playwright show-report
```

## Structure

```
tests/
  example.spec.ts        # starter test
  fixtures/
    base.fixture.ts      # shared test fixtures
playwright.config.ts     # Playwright configuration
```

## CI

GitHub Actions runs the full suite on push and PR. HTML reports are uploaded as artifacts.
