# ${{ values.name }}

> ${{ values.description }}

AI Agent service scaffolded from the IDP golden path.
Powered by **LangGraph** + **FastAPI**, with Prometheus metrics, MLflow trace logging,
and full GitOps deployment via Helm.

## Stack

| Layer | Technology |
|-------|-----------|
| Agent framework | [LangGraph](https://github.com/langchain-ai/langgraph) |
| API | [FastAPI](https://fastapi.tiangolo.com/) |
| LLM provider | `${{ values.llmProvider }}` / model `${{ values.llmModel }}` |
| Observability | Prometheus + MLflow traces |
| Deployment | Helm → Kind (local) / EKS (production) |

## Enabled Tools

{%- for tool in values.tools %}
- `{{ tool }}`
{%- endfor %}

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/healthz` | GET | Liveness probe → `{"status": "ok"}` |
| `/ready`   | GET | Readiness probe → `{"status": "ready"}` |
| `/metrics` | GET | Prometheus text format |
| `/invoke`  | POST | Run agent; returns `{output, session_id, run_id}` |
| `/docs`    | GET | Swagger UI |

### Example — invoke

```bash
curl -X POST http://localhost:${{ values.port }}/invoke \
  -H "Content-Type: application/json" \
  -d '{"message": "What is the capital of France?", "session_id": "sess-1"}'
```

## Local Development

```bash
# Install deps
pip install -r requirements.txt

# Run with Ollama (default)
OLLAMA_BASE_URL=http://localhost:11434 uvicorn src.main:app --reload --port ${{ values.port }}

# Run with OpenAI
LLM_PROVIDER=openai OPENAI_API_KEY=sk-... uvicorn src.main:app --reload --port ${{ values.port }}

# Tests
pytest tests/ -v
```

## Deploy to local Kind cluster

```bash
docker build -t localhost:5003/${{ values.name }}:local .
docker push localhost:5003/${{ values.name }}:local

helm upgrade --install ${{ values.name }} /path/to/helm/service-template \
  --namespace services \
  --set image.repository=localhost:5003/${{ values.name }} \
  --set image.tag=local \
  --values helm-values-local.yaml
```

## Required GitHub Secrets

Set these in your repository's **Settings → Secrets and variables → Actions**:

| Secret | Required | Purpose |
|--------|----------|---------|
| `GH_PAT` | Yes | Personal access token (`repo` scope) — CI pushes the updated image tag back to the platform repo to trigger GitOps |
| `AWS_ROLE_ARN` | AWS only | IAM role ARN for ECR push (`terraform output github_actions_role_arn`) |
| `LLM_API_KEY` | OpenAI only | OpenAI API key — set as a Kubernetes secret via the `add-secret` template |

## Tool Configuration

The scaffolded tools in `src/tools.py` ship as safe stubs by default. Activate real implementations via environment variables:

| Tool | Env var | What to set |
|------|---------|-------------|
| `web_search` | `WEB_SEARCH_API_KEY` | Tavily or SerpAPI key — the stub returns a placeholder until set |
| `k8s_lookup` | `K8S_IN_CLUSTER=true` | Enables the Kubernetes Python client with in-cluster service account credentials; requires a Role granting `get`/`list` on pods and deployments |
| `mlflow_query` | `MLFLOW_TRACKING_URI` | Already wired; points to `http://mlflow.ml-platform.svc.cluster.local:5000` by default |
| `calculator` | — | No external dependency; always active |

Both `web_search` and `k8s_lookup` are intentionally stubbed for local development so the service starts and passes health checks without external dependencies.

## Observability

- **Grafana dashboard**: http://grafana.idp.local/d/idp-ai-agent
- **MLflow UI**: http://mlflow.idp.local
- **Metrics**: `agent_invocations_total`, `agent_latency_seconds`, `llm_token_usage_total`, `agent_tool_calls_total`

## Cost Center

`${{ values.costCenter }}`
