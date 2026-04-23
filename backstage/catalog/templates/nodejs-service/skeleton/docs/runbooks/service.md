# ${{ values.name }} Service Runbook

## Overview

**Service:** ${{ values.name }}  
**Owner:** ${{ values.owner }}  
**Cost Center:** ${{ values.costCenter }}  
**Repository:** https://github.com/${{ values.githubOrg }}/${{ values.repoName }}

---

## Health Checks

```bash
# Check pod status
kubectl get pods -n services-dev -l app.kubernetes.io/name=${{ values.name }}

# Check liveness
kubectl exec -n services-dev deploy/${{ values.name }} -- wget -qO- http://localhost:${{ values.port }}/healthz

# Check readiness
kubectl exec -n services-dev deploy/${{ values.name }} -- wget -qO- http://localhost:${{ values.port }}/ready

# View recent logs
kubectl logs -n services-dev deploy/${{ values.name }} --tail=100 -f
```

---

## Common Issues

### Pod CrashLoopBackOff

1. Check logs: `kubectl logs -n services-dev deploy/${{ values.name }} --previous`
2. Check resource limits: `kubectl describe pod -n services-dev -l app.kubernetes.io/name=${{ values.name }}`
3. Verify the image exists in GHCR: check the [CI/CD workflow](https://github.com/${{ values.githubOrg }}/${{ values.repoName }}/actions)

### Service Unreachable (5xx)

1. Verify ingress: `kubectl get ingress -n services-dev ${{ values.name }}`
2. Check endpoint: `kubectl get endpoints -n services-dev ${{ values.name }}`
3. Test internal connectivity: `kubectl run curl --rm -it --image=curlimages/curl -- curl http://${{ values.name }}.services-dev.svc.cluster.local/healthz`

### High Memory / CPU

1. Check metrics: navigate to [Grafana](http://grafana.idp.local/d/idp-services) and filter to `${{ values.name }}`
2. Check HPA status: `kubectl get hpa -n services-dev`
3. Manually scale if needed: `kubectl scale deploy/${{ values.name }} -n services-dev --replicas=3`

---

## Rollback

```bash
# View Helm release history
helm history ${{ values.name }}-dev -n services-dev

# Roll back to previous release
helm rollback ${{ values.name }}-dev -n services-dev

# Or roll back ArgoCD app
argocd app rollback ${{ values.name }}-dev
```

---

## Escalation

1. Check [ArgoCD](http://argocd.idp.local/applications/${{ values.name }}-dev) for sync status
2. Check [Grafana alerts](http://grafana.idp.local/alerting) for active firing alerts
3. Raise an incident and page the on-call: owner group `${{ values.owner }}`
