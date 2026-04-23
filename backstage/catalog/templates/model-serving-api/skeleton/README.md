# ${{ values.name }}

> ${{ values.description }}

**Type:** ML Model Serving API | **Framework:** ${{ values.modelFramework }} | **Owner:** ${{ values.owner }}

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/predict` | POST | Run model inference |
| `/healthz` | GET | Liveness probe |
| `/ready` | GET | Readiness probe |
| `/metrics` | GET | Prometheus metrics |

## Quick start

```bash
# Local dev
pip install -r requirements.txt
uvicorn src.main:app --reload --port ${{ values.port }}

# Predict (stub mode — returns inputs when MODEL_URI is unset)
curl -X POST http://localhost:${{ values.port }}/v1/predict \
  -H "Content-Type: application/json" \
  -d '{"inputs": [[5.1, 3.5, 1.4, 0.2]]}'
```

## Loading a real model

Set `MODEL_URI` to a valid MLflow model reference before starting the server:

```bash
# From a run
export MODEL_URI="runs:/<run-id>/model"
# From the model registry
export MODEL_URI="models:/${{ values.name }}/Production"
export MLFLOW_TRACKING_URI="http://mlflow.idp.local"
```

## Local deployment

```bash
# Build and push to local registry
docker build -t localhost:5003/${{ values.name }}:latest .
docker push localhost:5003/${{ values.name }}:latest

# Deploy via Helm
helm upgrade --install ${{ values.name }}-dev ./../../helm/service-template \
  --namespace services-dev \
  --values helm-values-dev.yaml
```

## Required GitHub Secrets

Set these in your repository's **Settings → Secrets and variables → Actions**:

| Secret | Required | Purpose |
|--------|----------|---------|
| `GH_PAT` | Yes | Personal access token (`repo` scope) — CI pushes the updated image tag back to the platform repo to trigger GitOps |
| `AWS_ROLE_ARN` | AWS only | IAM role ARN for ECR push (`terraform output github_actions_role_arn`) |

Without `GH_PAT` the `update-image-tag` CI step will be skipped and ArgoCD won't pick up new builds automatically.

## Observability

- Metrics scraped automatically by Prometheus (`/metrics`)
- Grafana dashboard: [ML Model Serving](http://grafana.idp.local/d/idp-ml-serving)
- MLflow experiment tracking: [MLflow UI](http://mlflow.idp.local)
