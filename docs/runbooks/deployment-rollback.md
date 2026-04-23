# Deployment Rollback Runbook

## Alert Description

Triggered by: `DeploymentReplicasMismatch` (desired replicas ≠ available) or `HighHTTP5xxRate` (HTTP 5xx error rate > 5% for 5 minutes) after a deploy.

## Impact

Degraded or unavailable service. Users may see errors. Downstream services consuming this service's API are affected.

## Immediate Actions

### 1. Identify the bad deployment

```bash
# Check deployment status
kubectl rollout status deployment/<service-name> -n services

# View recent rollout history
helm history <service-name> -n services

# Check pod state
kubectl get pods -n services -l app.kubernetes.io/instance=<service-name>
kubectl describe pod <pod-name> -n services
```

### 2. Roll back via Helm

```bash
# Roll back to the previous release
helm rollback <service-name> -n services

# Or roll back to a specific revision
helm rollback <service-name> <revision-number> -n services

# Verify the rollback
kubectl rollout status deployment/<service-name> -n services --timeout=3m
```

### 3. Verify health after rollback

```bash
# Check endpoints
kubectl get endpoints <service-name> -n services

# Port-forward and smoke-test
kubectl port-forward deployment/<service-name> 8080:8080 -n services &
curl -s http://localhost:8080/healthz
curl -s http://localhost:8080/ready
```

### 4. If Helm rollback also fails — force a known-good image

```bash
# List recent ECR image tags
aws ecr list-images \
  --repository-name idp-mvp/<service-name> \
  --region us-east-1 \
  --query 'imageIds[*].imageTag' \
  --output text

# Force deploy with a known-good SHA tag
helm upgrade <service-name> ./helm/service-template \
  --namespace services \
  --set image.tag=<known-good-sha> \
  --reuse-values \
  --wait --timeout 5m
```

## Root Cause Analysis

Common causes:
- New image has a startup crash (check `kubectl logs`)
- ConfigMap or Secret reference is missing or wrong
- Resource limits too low causing OOMKilled on startup
- Broken health probe path returning non-200

```bash
# Check logs for the failing pod
kubectl logs deployment/<service-name> -n services --previous

# Check events
kubectl get events -n services --sort-by='.lastTimestamp' | tail -20
```

## Resolution Steps

1. Fix the underlying issue in the service code or configuration
2. Open a PR, get it reviewed, merge to `main`
3. CI/CD pipeline will build and deploy the fix automatically
4. Monitor Grafana dashboard for 15 minutes after the fix deploys

## Escalation

- Unresolved after 30 min → page platform team via `#platform-oncall`
- AWS EKS API unavailable → open AWS Support ticket (severity: High)

## Post-Incident

- Add the root cause to the incident thread in `#incidents`
- If this was caused by a missing check in CI, create a ticket to add it
- Update this runbook if new steps were discovered
