# ${{ values.name }}

${{ values.description }}

**LLM Provider:** `${{ values.llmProvider }}`  **Model:** `${{ values.llmModel }}`  
**Owner:** ${{ values.owner }}

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /healthz` | Liveness probe — returns `{"status":"ok"}` |
| `GET /ready` | Readiness probe — returns `{"status":"ready"}` |
| `GET /metrics` | Prometheus metrics |
| `POST /invoke` | Run the agent — body `{"input": "<prompt>", "session_id": "<optional>"}` |

## Tools enabled

${% for tool in values.tools %}- `${{ tool }}`
${% endfor %}

## Local development

```bash
# Install dependencies
pip install -r requirements.txt

# Set env vars (or create a .env file)
export LLM_PROVIDER=${{ values.llmProvider }}
export LLM_MODEL=${{ values.llmModel }}

# Start the server
uvicorn src.main:app --reload --port ${{ values.port }}
```

## Dashboards

- [Grafana — AI Agent](http://grafana.idp.local/d/idp-ai-agent)
- [MLflow Traces](http://mlflow.idp.local)

## Deployment

Deployed via GitHub Actions on push to `main`. Image pushed to GHCR then deployed to Kind/EKS via Helm.
