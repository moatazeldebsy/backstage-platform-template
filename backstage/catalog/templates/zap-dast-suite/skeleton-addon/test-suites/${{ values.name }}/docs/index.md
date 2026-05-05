# ${{ values.name }}

${{ values.description }}

## Overview

OWASP ZAP DAST security scan suite targeting **${{ values.targetService }}** at `${{ values.targetUrl }}`.

| Parameter | Value |
|-----------|-------|
| Scan type | `${{ values.scanType }}` |
| Fail threshold | `${{ values.failOnRiskLevel }}` risk and above |
| OpenAPI spec | `${{ values.openApiUrl }}` |

## Scan Modes

| Mode | Description |
|------|-------------|
| `baseline` | Passive scan only — fast, safe to run on production |
| `full` | Active attack simulation — run only against isolated environments |
| `api` | Scans via OpenAPI/Swagger spec — no browser required |

## Running Locally

Install ZAP: https://www.zaproxy.org/download/

```bash
# Baseline scan
docker run --rm -v $(pwd)/reports:/zap/wrk:rw \
  ghcr.io/zaproxy/zaproxy:stable zap-baseline.py \
  -t ${{ values.targetUrl }} \
  -r zap-report.html

# API scan (uses OpenAPI spec)
docker run --rm -v $(pwd)/reports:/zap/wrk:rw \
  ghcr.io/zaproxy/zaproxy:stable zap-api-scan.py \
  -t ${{ values.openApiUrl }} \
  -f openapi \
  -r zap-report.html
```

## CI

GitHub Actions runs a `${{ values.scanType }}` scan on every push to main. The HTML report is uploaded as a workflow artifact. Alerts at **${{ values.failOnRiskLevel }}** risk level or higher will fail the build.

## False Positive Management

Edit `.zap/rules.tsv` to suppress known false positives by rule ID.
