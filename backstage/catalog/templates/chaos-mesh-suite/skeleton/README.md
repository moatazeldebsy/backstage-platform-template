# ${{ values.name }}

${{ values.description }}

Chaos Mesh experiment suite for `${{ values.targetService }}` in namespace `${{ values.namespace }}`.

## Running experiments

```bash
# Apply a single experiment
kubectl apply -f experiments/pod-failure.yaml

# Wait for experiment to complete, then clean up
kubectl delete -f experiments/pod-failure.yaml

# Trigger all via CI (GitHub Actions → workflow_dispatch)
```

## Experiments

| File | Type | Effect |
|------|------|--------|
| `pod-failure.yaml` | PodChaos | Kills one pod |
| `network-latency.yaml` | NetworkChaos | Adds 100ms latency |
| `cpu-stress.yaml` | StressChaos | 80% CPU load |
| `memory-stress.yaml` | StressChaos | 256MB memory pressure |

Duration per experiment: **${{ values.duration }}**
