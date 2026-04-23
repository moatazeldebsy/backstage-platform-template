# ${{ values.name }}

${{ values.description }}

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Service info JSON |
| `GET /healthz` | Liveness probe — returns `{"status":"ok"}` |
| `GET /ready` | Readiness probe — returns `{"status":"ready"}` |
| `GET /metrics` | Prometheus metrics |

## Local development

```bash
go test ./src/...
go run ./src/
```

## Deployment

Deployed automatically via GitHub Actions on push to `main`.
Image is built, pushed to ECR, and deployed to EKS via Helm.
