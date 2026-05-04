# ${{ values.name }}

${{ values.description }}

Visual regression suite for `${{ values.targetService }}`. Pixel diff threshold: **${{ values.diffThreshold }}%**.

## Quick start

```bash
npm install
npx playwright install chromium

# First run: generate baseline snapshots
npm run test:update

# Subsequent runs: compare against baseline
npm test
```

Commit the `tests/__snapshots__/` directory as your golden baseline.
