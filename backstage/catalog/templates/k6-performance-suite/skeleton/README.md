# ${{ values.name }}

${{ values.description }}

k6 performance test suite targeting `${{ values.targetService }}`.

## Quick start

Install k6: https://k6.io/docs/get-started/installation/

```bash
k6 run tests/smoke.js                         # sanity check
k6 run tests/load.js                          # load test
k6 run tests/stress.js                        # stress test
k6 run -e TARGET_URL=http://... tests/load.js # override URL
```

## Scenarios

| Script | VUs | Duration | Purpose |
|--------|-----|----------|---------|
| smoke.js | 1 | 30s | Sanity |
| load.js | ${{ values.vus }} | ${{ values.duration }} | Normal load |
| stress.js | up to 3× | auto | Break-point |

## SLO Thresholds

- p95 latency < **${{ values.p95Threshold }}ms**
- Error rate < **1%**
