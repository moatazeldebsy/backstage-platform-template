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

## CI

Tests run automatically on push and PR (path-filtered to this suite directory) via GitHub Actions.
