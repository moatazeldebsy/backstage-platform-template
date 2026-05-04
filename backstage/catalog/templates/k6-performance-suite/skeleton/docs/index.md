# ${{ values.name }}

${{ values.description }}

## Overview

k6 performance test suite targeting **${{ values.targetService }}**.

| Parameter | Value |
|-----------|-------|
| Target URL | `${{ values.targetUrl }}` |
| Load VUs | ${{ values.vus }} |
| Load Duration | ${{ values.duration }} |
| p95 Threshold | ${{ values.p95Threshold }}ms |

## Scenarios

| Script | Purpose |
|--------|---------|
| `tests/smoke.js` | Sanity check — 1 VU for 30s |
| `tests/load.js` | Normal load — ${{ values.vus }} VUs for ${{ values.duration }} |
| `tests/stress.js` | Break-point test — ramps VUs until errors appear |

## Running Locally

Install k6: https://k6.io/docs/get-started/installation/

```bash
# Smoke test
k6 run tests/smoke.js

# Load test
k6 run tests/load.js

# Stress test
k6 run tests/stress.js
```

Override the target URL at runtime:

```bash
k6 run -e TARGET_URL=http://staging.example.com tests/load.js
```

## CI

GitHub Actions runs the smoke test on every push and the full load test on main branch merges. Results are pushed to the Prometheus Pushgateway for visibility in the QA Grafana dashboard.
