# ${{ values.name }} Service Runbook

## Overview

**Service:** ${{ values.name }}  
**Owner:** ${{ values.owner }}  
**Framework:** `${{ values.modelFramework }}`  
**Repository:** https://github.com/${{ values.githubOrg }}/${{ values.repoName }}

---

## Health Checks

```bash
# Check pod status
kubectl get pods -n services -l app.kubernetes.io/name=${{ values.name }}

# Check liveness
kubectl exec -n services deploy/${{ values.name }} -- wget -qO- http://localhost:${{ values.port }}/healthz

# Check readiness
kubectl exec -n services deploy/${{ values.name }} -- wget -qO- http://localhost:${{ values.port }}/ready

# View recent logs
kubectl logs -n services deploy/${{ values.name }} --tail=100 -f
```

---

## Test Prediction

```bash
curl -X POST http://${{ values.name }}.idp.local/predict \
  -H "Content-Type: application/json" \
  -d '{"features": [1.0, 2.0, 3.0]}'
```

---

## Common Issues

### Pod CrashLoopBackOff

1. Check logs: `kubectl logs -n services deploy/${{ values.name }} --previous`
2. Verify model artifact is available (check MLflow or bundled in image).
3. Check resource limits: `kubectl describe pod -n services -l app.kubernetes.io/name=${{ values.name }}`

### High Prediction Latency (p99 > SLO)

1. Check `prediction_latency_seconds` p99 in [Grafana ML dashboard](http://grafana.idp.local/d/idp-ml-serving).
2. Consider scaling replicas: `kubectl scale deploy/${{ values.name }} -n services --replicas=3`
3. Profile model inference — consider model quantisation or batching.

### Service Unreachable (5xx)

1. Verify ingress: `kubectl get ingress -n services ${{ values.name }}`
2. Check endpoint: `kubectl get endpoints -n services ${{ values.name }}`

---

## Rollback

```bash
# View Helm release history
helm history ${{ values.name }} -n services

# Roll back to previous release
helm rollback ${{ values.name }} -n services
```

---

## Escalation

1. Check [Grafana ML Model Serving dashboard](http://grafana.idp.local/d/idp-ml-serving).
2. Check [MLflow](http://mlflow.idp.local) for model version history.
3. Page on-call: owner group `${{ values.owner }}`.
