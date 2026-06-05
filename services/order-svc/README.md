# order-svc

Auto-scaffolded nodejs service.

## Getting Started

```bash
npm install
npm start
```

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Root — returns service name and status |
| `GET /healthz` | Liveness probe |
| `GET /ready` | Readiness probe |

## Running Tests

```bash
npm test
```

## Local Development (Kind)

```bash
# http://order-svc.idp.local
helm upgrade --install order-svc ./helm/service-template \
  --namespace services \
  --values services/order-svc/helm-values-local.yaml
```

## Deploying

Push to `main` to trigger CI/CD (GitHub Actions → GHCR → Helm deploy).
