# ${{ values.name }}

> ${{ values.description }}

A Kubernetes-native AI agent powered by [KAgent](https://github.com/kagent-dev/kagent) running **${{ values.model }}** via the **Anthropic Claude API**.

## Deploy

```bash
# Apply the Agent CRD to your Kind cluster
kubectl apply -f kubernetes/agent.yaml

# Verify
kubectl get agents -n kagent
```

## Chat with your agent

Open [http://kagent.idp.local](http://kagent.idp.local) and select **${{ values.name }}** from the agent list.

> Requires `kagent.idp.local` in `/etc/hosts` → `127.0.0.1`. Run once:
> ```bash
> sudo sh -c 'echo "127.0.0.1 kagent.idp.local" >> /etc/hosts'
> ```

## Tools available

| Tool | Enabled | Description |
|------|---------|-------------|
| `catalog_search` | ${{ values.enableCatalogSearch }} | Search Backstage service catalog |
| `get_service_metrics` | ${{ values.enableMetrics }} | Query Prometheus metrics |
| `scaffold_service` | ${{ values.enableScaffolding }} | Trigger Backstage templates |
| `list_deployments` | true | List K8s deployments |

## Model

- **Provider:** Anthropic Claude API
- **Model:** ${{ values.model }}
- **Secret:** `kagent-anthropic` in the `kagent` namespace (set via `bootstrap-ai.sh`)

> To switch models after scaffolding, update `spec.model` in `kubernetes/agent.yaml` and re-apply.

## Owner

${{ values.owner }}
