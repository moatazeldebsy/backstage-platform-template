# ${{ values.name }}

MLflow experiment — **${{ values.experimentName }}**

| Field | Value |
|-------|-------|
| Framework | ${{ values.framework }} |
| Python | ${{ values.pythonVersion }} |
| Owner | ${{ values.owner }} |

## Quick start

```bash
export MLFLOW_TRACKING_URI=http://mlflow.ml-platform.svc.cluster.local:5000
export MLFLOW_EXPERIMENT_NAME="${{ values.experimentName }}"
python train.py
```

## Links

- [MLflow UI](${{ values.mlflowUrl }})
- [Backstage catalog](${{ values.backstageUrl }}/catalog/default/component/${{ values.name }})
- [Runbook](runbooks/experiment.md)
