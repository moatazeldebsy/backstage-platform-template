# test-zap

OWASP ZAP `baseline` DAST scan for `hello-service` at `http://localhost:8080`.

```bash
# Requires Docker
docker run --rm -v $(pwd)/reports:/zap/wrk:rw \
  ghcr.io/zaproxy/zaproxy:stable zap-baseline.py \
  -t http://localhost:8080 -r zap-report.html
```

Suppress false positives in `.zap/rules.tsv`.
