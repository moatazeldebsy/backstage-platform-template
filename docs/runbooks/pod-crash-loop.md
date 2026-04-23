# Pod Crash Loop Runbook

## Alert Description

**Alert:** `PodCrashLooping`
**Severity:** Critical
**Expression:** Pod restart count increases more than 3 times in 5 minutes.

## Impact

The service is unavailable or has reduced capacity. Kubernetes is repeatedly trying to restart the container. Other pods in the Deployment may still be serving traffic (partial outage) or all pods may be failing (full outage).

## Immediate Actions

### 1. Identify the crashing pod

```bash
# Find crash-looping pods
kubectl get pods -n services | grep -E 'CrashLoopBackOff|Error|OOMKilled'

# Check restart count and last state
kubectl describe pod <pod-name> -n services
```

Look at the `Last State` section — it tells you the exit code:
- Exit code `0` — intentional exit (bug in startup logic)
- Exit code `1` — application error
- Exit code `137` — OOMKilled (out of memory)
- Exit code `139` — segfault

### 2. Read the logs

```bash
# Current container logs
kubectl logs <pod-name> -n services

# Previous container logs (before the crash)
kubectl logs <pod-name> -n services --previous
```

### 3. OOMKilled — increase memory limit

```bash
# Confirm OOMKilled
kubectl describe pod <pod-name> -n services | grep -A5 "Last State"

# Temporary fix: patch the deployment (edit helm-values.yaml for a permanent fix)
kubectl set resources deployment/<service-name> \
  -n services \
  --limits=memory=512Mi \
  --requests=memory=256Mi
```

### 4. Application error — roll back

If logs show a startup error introduced in a recent deploy:

```bash
helm rollback <service-name> -n services
```

See [Deployment Rollback](deployment-rollback.md) for full rollback procedure.

### 5. ImagePullBackOff — fix image reference

```bash
# Check the error
kubectl describe pod <pod-name> -n services | grep -A10 "Events"

# Verify ECR image exists
aws ecr describe-images \
  --repository-name idp-mvp/<service-name> \
  --image-ids imageTag=<tag> \
  --region us-east-1
```

## Root Cause Analysis

| Symptom | Likely Cause |
|---------|-------------|
| Exit code 137, OOMKilled | Memory limit too low |
| Exit code 1, stack trace in logs | Application bug in new release |
| `ImagePullBackOff` | Wrong image tag or ECR permissions issue |
| `CreateContainerConfigError` | Missing ConfigMap or Secret |
| `CrashLoopBackOff` with empty logs | Health probe failing before app is ready |

```bash
# Check for missing secrets / configmaps
kubectl get events -n services --sort-by='.lastTimestamp' | grep -i "secret\|configmap"
```

## Resolution Steps

1. Identify the root cause using the table above
2. Apply the immediate fix (rollback, resource patch, or secret fix)
3. Verify pods stabilise: `kubectl get pods -n services -w`
4. For a permanent fix: update `helm-values.yaml` and open a PR

## Escalation

- OOMKilled repeatedly after memory increase → application has a memory leak; escalate to service owner
- All pods crashing and rollback fails → page platform team

## Post-Incident

- Record the exit code and cause in the incident thread
- If OOMKilled: add a memory profiling ticket for the service team
- If it was a broken deploy: review CI checks — was there a test that should have caught this?
