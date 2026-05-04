# ${{ values.name }}

${{ values.description }}

## Overview

Playwright E2E test suite targeting **${{ values.targetService }}**.

- **Base URL:** `${{ values.baseUrl }}`
- **Owner:** ${{ values.owner }}

## Running Tests

```bash
npm install
npx playwright install --with-deps
npx playwright test
```

View the HTML report after a run:

```bash
npx playwright show-report
```

## CI

Tests run automatically on every push and pull request via GitHub Actions. The HTML report is uploaded as a workflow artifact and retained for 30 days.

## LambdaTest

To run tests on LambdaTest's cloud grid, set the following repository secrets:

| Secret | Description |
|--------|-------------|
| `LT_USERNAME` | LambdaTest username |
| `LT_ACCESS_KEY` | LambdaTest access key |

Then uncomment the LambdaTest steps in `.github/workflows/e2e.yml`.
