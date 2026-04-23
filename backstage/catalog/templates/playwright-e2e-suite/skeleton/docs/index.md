# ${{ values.name }}

${{ values.description }}

## Target service

`${{ values.targetServiceUrl }}`

## Test scenarios

| File | Coverage |
|------|----------|
| `tests/smoke.spec.ts` | Homepage load, basic navigation |
| `tests/api.spec.ts` | API health and readiness endpoints |

## Running locally

```bash
npm install
npx playwright install --with-deps chromium

# Run all tests
npx playwright test

# Run against a different URL
BASE_URL=http://my-service.local npx playwright test

# Open interactive UI mode
npx playwright test --ui
```

## CI/CD

| Trigger | Behaviour |
|---------|-----------|
| Push / PR | Full Playwright suite on Chromium |
| Schedule (`${{ values.runSchedule }}`) | Scheduled regression run |
| `workflow_dispatch` | Manual run with optional URL override |

HTML reports are uploaded as artifacts (retained 30 days). Pass/fail metrics are pushed to the Prometheus Pushgateway (if `PUSHGATEWAY_URL` is set) and appear in the **QA Platform Metrics** Grafana dashboard.
