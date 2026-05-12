# ML Experiment (MLflow)

Run a Python ML training job with MLflow tracking. Scaffolds the experiment locally and submits
a Kubernetes Job to the `ml-platform` namespace. Results appear in the MLflow UI.

## What it creates

- A Python training script with MLflow experiment tracking
- A Kubernetes Job manifest submitted to the `ml-platform` namespace
- A `catalog-info.yaml` registered in the Backstage catalog
- A GitHub Actions CI workflow for the experiment

## Prerequisites

- Local Kind cluster running with the AI/ML stack (`./scripts/bootstrap-ai.sh`)
- MLflow tracking server running at `http://mlflow.idp.local`

## Parameters

| Parameter | Description |
|-----------|-------------|
| `name` | Experiment name |
| `description` | What this experiment trains |
| `owner` | Backstage owner group |

## After scaffolding

The training job runs in the `ml-platform` namespace. Track runs, metrics, and artifacts
in the MLflow UI at `http://mlflow.idp.local`.
