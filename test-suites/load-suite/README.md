# load-suite

k6 performance suite for `hello-service` — 20 VUs, 2m, p95 < 500ms.

```bash
k6 run tests/smoke.js
k6 run tests/load.js
k6 run tests/stress.js
k6 run -e TARGET_URL=http://staging.example.com tests/load.js
```
