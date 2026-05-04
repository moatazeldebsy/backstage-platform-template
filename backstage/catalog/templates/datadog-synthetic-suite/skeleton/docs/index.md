# ${{ values.name }}

${{ values.description }}

## Overview

Datadog synthetic monitoring suite for **${{ values.targetService }}** at `${{ values.targetUrl }}`.

| Parameter | Value |
|-----------|-------|
| Datadog site | `${{ values.datadogSite }}` |
| Target URL | `${{ values.targetUrl }}` |
| Test locations | ${{ values.locations | join(', ') }} |

## Test Definitions

Test definitions live in `synthetics/` as JSON files compatible with `datadog-ci synthetics`:

| File | Type | Purpose |
|------|------|---------|
| `synthetics/api-test.json` | API | HTTP health and assertion check |
| `synthetics/browser-test.json` | Browser | Recorded browser journey |

## Running Tests Manually

```bash
npm install

# Trigger all synthetic tests and wait for results
DD_API_KEY=<key> DD_APP_KEY=<app_key> npm test
```

## CI

GitHub Actions triggers all synthetic tests on every deployment to main and blocks promotion if any test fails. Set the following repository secrets:

| Secret | Description |
|--------|-------------|
| `DD_API_KEY` | Datadog API key |
| `DD_APP_KEY` | Datadog application key |

## Links

- [Datadog Synthetics Dashboard](https://app.${{ values.datadogSite }}/synthetics)
- [datadog-ci docs](https://github.com/DataDog/datadog-ci/blob/master/src/commands/synthetics/README.md)
