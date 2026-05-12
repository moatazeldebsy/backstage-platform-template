# test-go-svc

Auto-scaffolded go service.

## Getting Started

```bash
go run ./src/...
```

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Root — returns service name and status |
| `GET /healthz` | Liveness probe |
| `GET /ready` | Readiness probe |

## Running Tests

```bash
go test ./src/...
```

## Local Development (Kind)

```bash
# http://test-go-svc.idp.local
helm upgrade --install test-go-svc ./helm/service-template \
  --namespace services \
  --values services/test-go-svc/helm-values-local.yaml
```

## Deploying

Push to `main` to trigger CI/CD (GitHub Actions → GHCR → Helm deploy).
