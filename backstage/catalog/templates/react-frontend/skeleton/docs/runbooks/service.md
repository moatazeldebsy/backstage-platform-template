# ${{ values.name }} Frontend Runbook

## Overview

**App:** ${{ values.name }}  
**Owner:** ${{ values.owner }}  
**Cost Center:** ${{ values.costCenter }}  
**Repository:** https://github.com/${{ values.githubOrg }}/${{ values.repoName }}

---

## Health Checks

```bash
# Check pod status
kubectl get pods -n services-dev -l app.kubernetes.io/name=${{ values.name }}

# Check ingress
kubectl get ingress -n services-dev ${{ values.name }}

# View recent logs
kubectl logs -n services-dev deploy/${{ values.name }} --tail=100 -f
```

---

## Common Issues

### Pod CrashLoopBackOff

1. Check logs: `kubectl logs -n services-dev deploy/${{ values.name }} --previous`
2. Verify the image exists in GHCR: check the [CI/CD workflow](https://github.com/${{ values.githubOrg }}/${{ values.repoName }}/actions)

### App Unavailable (404 / 502)

1. Verify ingress: `kubectl get ingress -n services-dev ${{ values.name }}`
2. Check nginx ingress controller logs: `kubectl logs -n ingress-nginx deploy/ingress-nginx-controller --tail=50`
3. Ensure `/etc/hosts` entry exists for `${{ values.name }}-dev.idp.local` (see `local/hosts-append.txt`)

### High Memory / CPU

1. Check metrics in [Grafana](http://grafana.idp.local/d/idp-services) — filter to `${{ values.name }}`
2. Manually scale if needed: `kubectl scale deploy/${{ values.name }} -n services-dev --replicas=3`

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
