# ${{ values.name }}

> ${{ values.description }}

A Kubernetes-native AI agent powered by [KAgent](https://github.com/kagent-dev/kagent),
running **${{ values.model }}** via the **Anthropic Claude API**.

## Tools

| Tool | Enabled | Description |
|------|---------|-------------|
| `catalog_search` | ${{ values.enableCatalogSearch }} | Search the Backstage service catalog |
| `get_service_metrics` | ${{ values.enableMetrics }} | Query Prometheus metrics |
| `scaffold_service` | ${{ values.enableScaffolding }} | Trigger Backstage scaffolder templates |
| `list_deployments` | true | List Kubernetes deployments |

## Quick start

```bash
# Apply the Agent CRD
kubectl apply -f kubernetes/agent.yaml

# Verify
kubectl get agents -n kagent

# Open KAgent UI
open http://kagent.idp.local
```

## Model

- **Provider:** Anthropic Claude API
- **Model:** ${{ values.model }}
- **Secret:** `kagent-anthropic` (namespace: `kagent`) — created by `bootstrap-ai.sh`

> To switch models, update `spec.model` in `kubernetes/agent.yaml` and re-apply.
> Available: `claude-haiku-4-5-20251001`, `claude-sonnet-4-6`, `claude-opus-4-7`

## Links

- [KAgent UI](http://kagent.idp.local)
- [Backstage catalog](http://backstage.idp.local/catalog/default/component/${{ values.name }})
- [Runbook](runbooks/agent.md)
