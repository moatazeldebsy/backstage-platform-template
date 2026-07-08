# ${{ values.name }}

${{ values.description }}

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /healthz` | Liveness probe — returns `{"status":"ok"}` |
| `GET /ready` | Readiness probe — returns `{"status":"ready"}` |
| `GET /metrics` | Prometheus metrics |

## Local development

```bash
bundle install
bundle exec puma -p ${{ values.port }}
```

## Deployment

Deployed automatically via GitHub Actions on push to `main`.
Image is built, pushed to GHCR, and deployed via Helm.
