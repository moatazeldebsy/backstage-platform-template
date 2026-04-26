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
# Build and push to the local registry
docker build -t localhost:5003/my-svc:latest .
docker push localhost:5003/my-svc:latest

# Deploy with Helm (run from inside services/my-svc/)
helm upgrade --install my-svc ../../helm/service-template \
  --namespace services \
  --create-namespace \
  --set image.repository=localhost:5003/my-svc \
  --set image.tag=latest \
  --values helm-values-local.yaml

# http://my-svc.idp.local
```

## Deploying

Push to `main` to trigger CI/CD (GitHub Actions → ECR → Helm deploy).

```bash
# Manual Helm deploy (local) — run from inside services/my-svc/
helm upgrade --install my-svc ../../helm/service-template \
  --namespace services \
  --create-namespace \
  --set image.repository=localhost:5003/my-svc \
  --set image.tag=latest \
  --values helm-values-local.yaml

# Manual Helm deploy (AWS)
helm upgrade --install my-svc ./helm/service-template \
  --namespace services \
  --set image.repository=<ECR_URI>/my-svc \
  --set image.tag=<git-sha> \
  --values services/my-svc/helm-values.yaml
```
