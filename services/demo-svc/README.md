# demo-svc

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
# http://demo-svc.idp.local
helm upgrade --install demo-svc ./helm/service-template \
  --namespace services \
  --values services/demo-svc/helm-values-local.yaml
```

## Deploying

Push to `main` to trigger CI/CD (GitHub Actions → GHCR → Helm deploy).
