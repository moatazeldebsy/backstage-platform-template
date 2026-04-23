# hello-service

Reference Go service deployed via the IDP golden path.

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Returns service info JSON |
| `GET /healthz` | Liveness probe |
| `GET /ready` | Readiness probe |
| `GET /metrics` | Prometheus metrics |

## Local development

```bash
cd services/hello-service
go test ./src/...
```

## Deployment

Deployed automatically via GitHub Actions on push to `main`.
