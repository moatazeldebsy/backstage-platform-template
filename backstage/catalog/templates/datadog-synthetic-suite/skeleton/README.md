# ${{ values.name }}

${{ values.description }}

Datadog synthetic tests for `${{ values.targetService }}` on `${{ values.datadogSite }}`.

## Quick start

```bash
npm install
DD_API_KEY=<key> DD_APP_KEY=<app_key> npm test
```

## Required secrets

| Secret | Description |
|--------|-------------|
| `DD_API_KEY` | Datadog API key |
| `DD_APP_KEY` | Datadog application key |

Set these in GitHub repository settings → Secrets and variables → Actions.
