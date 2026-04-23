# ${{ values.name }}

${{ values.description }}

**Framework:** `${{ values.modelFramework }}`  **MLflow Experiment:** `${{ values.mlflowExperiment or "—" }}`  
**Owner:** ${{ values.owner }}

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /healthz` | Liveness probe — returns `{"status":"ok"}` |
| `GET /ready` | Readiness probe — returns `{"status":"ready"}` |
| `GET /metrics` | Prometheus metrics |
| `POST /predict` | Run inference — body `{"features": [...]}` |

## Local development

```bash
pip install -r requirements.txt
uvicorn src.main:app --reload --port ${{ values.port }}
```

## Metrics exposed

- `prediction_latency_seconds` — histogram of inference latency
- `predictions_total` — counter of total predictions
- `http_requests_total` — counter by status code

## Dashboards

- [Grafana — ML Model Serving](http://grafana.idp.local/d/idp-ml-serving)
- [MLflow Experiments](http://mlflow.idp.local)

## Deployment

Deployed via GitHub Actions on push to `main`. Image pushed to GHCR/ECR, deployed via Helm to the `services` namespace.
