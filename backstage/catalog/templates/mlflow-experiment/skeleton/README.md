# ${{ values.name }}

MLflow experiment — **${{ values.experimentName }}**

- **Framework:** ${{ values.framework }}
- **Python:** ${{ values.pythonVersion }}
- **Owner:** ${{ values.owner }}

## Run training

```bash
# Set tracking URI (automatically set via CI secret)
export MLFLOW_TRACKING_URI=http://mlflow.ml-platform.svc.cluster.local:5000
export MLFLOW_EXPERIMENT_NAME="${{ values.experimentName }}"

python train.py
```

## View results

Open [http://mlflow.idp.local](http://mlflow.idp.local) and select **${{ values.experimentName }}**.

## Kubernetes training job

An initial training job was submitted to the `ml-platform` namespace at scaffold time.
Monitor it with:

```bash
kubectl get pods -n ml-platform -l app=${{ values.name }}
kubectl logs -n ml-platform -l app=${{ values.name }}
```
