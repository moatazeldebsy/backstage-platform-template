# ${{ values.name }}

${{ values.description }}

**Framework:** `${{ values.modelFramework }}`  **MLflow Experiment:** `${{ values.mlflowExperiment }}`  
**Owner:** ${{ values.owner }}

## What this job does

A containerised ML training job orchestrated by Argo Workflows and tracked in MLflow.

| Item | Value |
|------|-------|
| Framework | `${{ values.modelFramework }}` |
| MLflow Experiment | `${{ values.mlflowExperiment }}` |
| Cron Schedule | `${{ values.cronSchedule or "manual-only" }}` |
| Cost Center | `${{ values.costCenter }}` |

## Local development

```bash
pip install -r requirements.txt

# Train locally
python src/train.py

# Inspect runs
mlflow ui --port 5000
```

## Triggering the job

```bash
# Submit a single run via Argo CLI
argo submit workflow.yaml -n ml-platform --watch

# Or trigger via Argo Workflows UI at http://argo-workflows.idp.local
```

## Monitoring

- [MLflow Experiments](http://mlflow.idp.local)
- [Argo Workflows](http://argo-workflows.idp.local)
