# ${{ values.name }} Runbook

**Owner:** ${{ values.owner }}  
**Experiment:** ${{ values.experimentName }}  
**Framework:** ${{ values.framework }}

---

## Health checks

```bash
# Check training job status
kubectl get pods -n ml-platform -l app=${{ values.name }}

# Check MLflow is reachable
curl -s ${{ values.mlflowUrl }}/health
```

---

## Common issues

### Training job fails to start

```bash
kubectl describe pod -n ml-platform -l app=${{ values.name }}
kubectl logs -n ml-platform -l app=${{ values.name }}
```

### MLflow tracking URI not reachable

The `MLFLOW_TRACKING_URI` secret points to the in-cluster service.
Verify MLflow is running:

```bash
kubectl get pods -n ml-platform -l app=mlflow
```

### Re-run training manually

```bash
kubectl delete job ${{ values.name }}-initial-run -n ml-platform 2>/dev/null || true
# Then re-apply the job from the IDP scaffolder or run locally:
export MLFLOW_TRACKING_URI=${{ values.mlflowUrl }}
python train.py
```

---

## Escalation

1. Check [MLflow UI](${{ values.mlflowUrl }}) for experiment runs
2. Check [Grafana](${{ values.grafanaUrl }}) for ml-platform namespace metrics
3. Page owner: `${{ values.owner }}`
