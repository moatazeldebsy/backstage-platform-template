# ${{ values.name }} Job Runbook

## Overview

**Job:** ${{ values.name }}  
**Owner:** ${{ values.owner }}  
**Framework:** `${{ values.modelFramework }}`  
**MLflow Experiment:** `${{ values.mlflowExperiment }}`  
**Repository:** https://github.com/${{ values.githubOrg }}/${{ values.repoName }}

---

## Trigger a Run

```bash
# Via Argo CLI
argo submit workflow.yaml -n ml-platform --watch

# Via Argo UI
# http://argo-workflows.idp.local
```

---

## Check Run Status

```bash
# List recent workflow runs
argo list -n ml-platform --selector app.kubernetes.io/name=${{ values.name }}

# Stream logs for latest run
argo logs -n ml-platform @latest
```

---

## Common Issues

### Workflow Stuck / Pending

1. Check pod events: `kubectl describe pod -n ml-platform -l workflows.argoproj.io/workflow`
2. Verify PVC is bound: `kubectl get pvc -n ml-platform`
3. Check resource quotas: `kubectl describe resourcequota -n ml-platform`

### Training Failure / Low Accuracy

1. Check MLflow run for metrics and params: [http://mlflow.idp.local](http://mlflow.idp.local)
2. Review logs: `argo logs -n ml-platform @latest`
3. Re-run with adjusted hyperparameters by editing `workflow.yaml`

---

## Rollback / Re-run

```bash
# Re-submit the last successful workflow spec
argo resubmit -n ml-platform <workflow-name>
```

---

## Escalation

1. Check [Argo Workflows UI](http://argo-workflows.idp.local) for error details.
2. Check [MLflow](http://mlflow.idp.local) for run history.
3. Page on-call: owner group `${{ values.owner }}`.
