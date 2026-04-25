# my-svc

Auto-scaffolded Node.js/Express service.

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
tilt up
# http://my-svc.idp.local
```

## Deploying

Push to `main` to trigger CI/CD (GitHub Actions → ECR → Helm deploy).

```bash
# Manual Helm deploy (local)
helm upgrade --install my-svc ./helm/service-template \
  --namespace services \
  --set image.repository=localhost:5001/my-svc \
  --set image.tag=latest \
  --values services/my-svc/helm-values-local.yaml

# Manual Helm deploy (AWS)
helm upgrade --install my-svc ./helm/service-template \
  --namespace services \
  --set image.repository=<ECR_URI>/my-svc \
  --set image.tag=<git-sha> \
  --values services/my-svc/helm-values.yaml
```
