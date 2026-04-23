# ${{ values.name }} — k6 Performance Test Suite

${{ values.description }}

## Target service

`${{ values.targetServiceUrl }}`

## Thresholds

| Metric | Threshold |
|--------|-----------|
| p95 latency | < ${{ values.p95LatencyThresholdMs }} ms |
| Error rate | < ${{ values.errorRateThreshold }}% |
| Peak virtual users | ${{ values.virtualUsers }} |

## Scenarios

| File | Purpose |
|------|---------|
| `tests/smoke.js` | 1 VU × 30s — quick sanity check; runs on every PR |
| `tests/load.js` | Ramping load up to ${{ values.virtualUsers }} VUs — runs on schedule and merge to main |
| `tests/stress.js` | Pushes to ${{ values.virtualUsers * 3 }} VUs — finds breaking point; trigger manually |

## Running locally

```bash
# Install k6 (macOS)
brew install k6

# Smoke
BASE_URL=http://localhost:8080 k6 run tests/smoke.js

# Load
BASE_URL=http://localhost:8080 k6 run tests/load.js

# Stress
BASE_URL=http://localhost:8080 k6 run tests/stress.js
```

## CI

- **Pull requests** → smoke test only (fast, ~30s)
- **Push to main / schedule** → full load test with threshold enforcement
- **Manual dispatch** → choose scenario (smoke / load / stress) and optionally override URL

Results are uploaded as GitHub artifacts and metrics are pushed to Prometheus Pushgateway for the [QA Platform Grafana dashboard](http://grafana.idp.local/d/qa-metrics).

## Required secret

| Secret | Purpose |
|--------|---------|
| `PUSHGATEWAY_URL` | Optional — push metrics to Prometheus; CI skips if unset |
