# ${{ values.name }} — Playwright E2E Suite

${{ values.description }}

**Target:** `${{ values.targetServiceUrl }}`  
**Schedule:** `${{ values.runSchedule }}` (UTC cron)  
**Owner:** ${{ values.owner }}

## Running locally

```bash
npm install
npx playwright install chromium

# Run all tests against the default target
npm test

# Override base URL
BASE_URL=http://localhost:8080 npm test

# Run only smoke tests
npm run test:smoke

# View HTML report
npm run test:report
```

## CI

Tests run automatically on:
- Every push / PR to `main`
- Scheduled cron (`${{ values.runSchedule }}`)
- Manual trigger via `workflow_dispatch` (allows URL override)

The HTML report is uploaded as a GitHub Actions artifact (`playwright-report-<run>`) and retained for 30 days.

## Adding tests

Place new spec files in `tests/`. Playwright discovers any `*.spec.ts` file automatically.

## Metrics

If `PUSHGATEWAY_URL` is set as a GitHub Actions secret, the CI job pushes
`e2e_pass_rate` and `e2e_tests_total` metrics to Prometheus for the QA dashboard.

## Required secrets

| Secret | Required | Purpose |
|--------|----------|---------|
| `PUSHGATEWAY_URL` | No | Send QA metrics to Prometheus |
