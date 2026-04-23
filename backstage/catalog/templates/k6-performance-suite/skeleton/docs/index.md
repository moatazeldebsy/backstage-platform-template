# ${{ values.name }}

${{ values.description }}

## Target service

`${{ values.targetServiceUrl }}`

## Test scenarios

| Scenario | When | Purpose |
|----------|------|---------|
| **Smoke** | Every PR | Verify the service is alive with 1 VU for 30 s |
| **Load** | Every merge to main | Ramp to ${{ values.virtualUsers }} VUs, hold for 3 min |
| **Stress** | Scheduled / manual | Push to 3× peak VUs to find the breaking point |

## Thresholds

| Metric | Threshold |
|--------|-----------|
| p95 response time | < ${{ values.p95LatencyThresholdMs }} ms |
| Error rate | < ${{ values.errorRateThreshold }}% |

## Running locally

```bash
# Install k6: https://k6.io/docs/get-started/installation/

# Smoke test
k6 run tests/smoke.js

# Load test against a different URL
BASE_URL=http://my-service.local k6 run tests/load.js

# Stress test
BASE_URL=http://my-service.local k6 run tests/stress.js
```

## Metrics

Results are pushed to the Prometheus Pushgateway (if `PUSHGATEWAY_URL` is set) and appear in the **QA Platform Metrics** Grafana dashboard:

- `perf_http_req_duration_p95_ms{suite="${{ values.name }}"}` — p95 latency
- `perf_http_error_rate{suite="${{ values.name }}"}` — HTTP error rate
- `perf_http_requests_total{suite="${{ values.name }}"}` — total requests per run
