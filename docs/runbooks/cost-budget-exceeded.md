# Runbook: TeamBudgetWarning / TeamBudgetExceeded

**Alert:** `TeamBudgetWarning` (>80 % budget consumed) or `TeamBudgetExceeded` (>100 %)  
**Severity:** Warning / Critical  
**Category:** finops

## What is happening

The `tech-insights-exporter` CronJob queries the OpenCost API every 15 minutes and pushes
`idp_team_actual_cost_usd_monthly{team}` to Pushgateway. This alert fires when that value
exceeds the configured threshold in `idp_team_budget_usd_monthly{team}`.

## Immediate triage

```bash
# Which teams are over budget?
kubectl exec -n monitoring deploy/prometheus-operator -c prometheus -- \
  curl -s localhost:9090/api/v1/query \
  --data-urlencode 'query=idp_team_budget_utilization_ratio > 0.8' | jq '.data.result'

# What's running in the team's namespace?
kubectl top pods -n services-dev --sort-by=memory
kubectl top pods -n services     --sort-by=memory

# Check OpenCost breakdown for the team
open http://opencost.idp.local
```

## Remediation steps

1. **Identify the biggest spenders** — sort OpenCost by namespace → drill into workload.
2. **Scale down non-critical workloads** — reduce replicas or apply a HPA max ceiling:
   ```bash
   kubectl scale deployment <name> -n services-dev --replicas=1
   ```
3. **Right-size resource requests** — over-provisioned requests inflate cost allocation:
   ```bash
   kubectl set resources deployment/<name> -n services-dev \
     --requests=cpu=100m,memory=128Mi --limits=cpu=500m,memory=512Mi
   ```
4. **Update the team budget** — if the current budget is too low, raise it:
   - Edit `idp.io/cost-budget-monthly-usd` annotation on the Group entity in
     `backstage/catalog/catalog-info.yaml`.
   - Update the matching entry in `kubernetes/finops/team-budgets-configmap.yaml`.
   - The new value will take effect on the next exporter run (≤15 minutes).

## How budgets are set

Budgets live in two authoritative locations (keep in sync):
- **Backstage catalog** — `idp.io/cost-budget-monthly-usd` annotation on each `Group` entity
  in `backstage/catalog/catalog-info.yaml` and `backstage/catalog/qa-catalog.yaml`.
- **Kubernetes ConfigMap** — `kubernetes/finops/team-budgets-configmap.yaml`
  (`data.budgets.json`) read by the exporter via `TEAM_BUDGETS_JSON` env var.

Defaults (USD/month): platform-team $2000, ml-team $1500, backend-team $600,
data-team $800, frontend-team $400, android-team $300, ios-team $300, qa-team $200.
