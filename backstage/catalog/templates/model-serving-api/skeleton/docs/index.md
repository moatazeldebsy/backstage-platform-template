# ${{ values.name }}

Model serving API for **${{ values.modelName }}** deployed on **${{ values.target }}** infrastructure.

## Endpoints

| Path | Method | Description |
|------|--------|-------------|
| `/health` | GET | Health check — returns `{"status":"ok","model":"..."}` |
| `/v1/models` | GET | List available models |
| `/v1/completions` | POST | Text completion (OpenAI-compatible) |
| `/v1/chat/completions` | POST | Chat completion (OpenAI-compatible) |
| `/metrics` | GET | Prometheus metrics |

## Local access

```
http://${{ values.name }}.idp.local
```

## Deployment

- **Target:** ${{ values.target }}
- **Model:** ${{ values.modelName }}
- **Namespace:** `ml-platform`
- **Owner:** ${{ values.owner }}

## Monitoring

The model server exposes `model_server_requests_total{model="${{ values.modelName }}"}` to Prometheus.
It is registered in the MLflow Model Registry — find it at [http://mlflow.idp.local/#/models](http://mlflow.idp.local/#/models).
