# ${{ values.name }}

> ${{ values.description }}

**Type:** ML Training Job | **Framework:** ${{ values.modelFramework }} | **Owner:** ${{ values.owner }}

## Quick start

```bash
# Local dev — requires MLflow running
pip install -r requirements.txt

export MLFLOW_TRACKING_URI=http://mlflow.idp.local
export MLFLOW_EXPERIMENT_NAME=${{ values.mlflowExperiment }}

python -m src.train
```

## Required GitHub Secrets

Set these in your repository's **Settings → Secrets and variables → Actions**:

| Secret | Required | Purpose |
|--------|----------|---------|
| `AWS_ROLE_ARN` | AWS only | IAM role ARN for ECR push (`terraform output github_actions_role_arn`) |

## Argo Workflows — submit a run

**Prerequisites (local Kind):**
- Argo Workflows installed in `ml-platform` namespace (`bootstrap-local.sh` does this)
- MLflow reachable at `http://mlflow.idp.local` (add to `/etc/hosts` from `local/hosts-append.txt`)
- Image pushed to local registry: `docker push localhost:5003/${{ values.name }}:latest`

```bash
# One-off run (latest image)
argo submit workflow.yaml --watch -n ml-platform

# Override hyperparameters
argo submit workflow.yaml \
  --parameter image-tag=<sha> \
  --parameter n-estimators=200 \
  --watch -n ml-platform
```

## Build and push image

```bash
# Push to GHCR (CI handles this on main push)
docker build -t ghcr.io/${{ values.githubOrg }}/${{ values.name }}:latest .
docker push ghcr.io/${{ values.githubOrg }}/${{ values.name }}:latest

# Push to local registry for Kind
docker tag ghcr.io/${{ values.githubOrg }}/${{ values.name }}:latest \
  localhost:5003/${{ values.name }}:latest
docker push localhost:5003/${{ values.name }}:latest
```

## View results

- [MLflow Experiment](<http://mlflow.idp.local/#/experiments>)
- [Argo Workflows UI](<http://argo-workflows.idp.local>)
