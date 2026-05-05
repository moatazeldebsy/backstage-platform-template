# ${{ values.name }}

${{ values.description }}

OWASP ZAP `${{ values.scanType }}` DAST scan targeting `${{ values.targetService }}`.

## Quick start

```bash
# Requires Docker
docker run --rm -v $(pwd)/reports:/zap/wrk:rw \
  ghcr.io/zaproxy/zaproxy:stable zap-${{ values.scanType }}.py \
  -t ${{ values.targetUrl }} -r zap-report.html
```

## False positive suppression

Edit `.zap/rules.tsv` — one rule ID per line with `IGNORE` action.
