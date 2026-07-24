# DR Region Failover Runbook

## Alert Description

Triggered when eu-central-1 (primary) is degraded or unreachable in a multi-region (V2) deployment: Global Accelerator health checks failing, Aurora Global writer unavailable, or a regional AWS outage. See [docs/multi-region.md](../multi-region.md) for the full V2 architecture this runbook operates against.

## Impact

- Backstage, ArgoCD hub, and all `services-dev` workloads in eu-central-1 are unreachable.
- Writes to Aurora Global and DynamoDB Global Tables stop until failover completes.
- us-east-1 is a warm standby — read replicas are live, but not yet accepting writes or primary traffic.

## Pre-Checks

Before failing over, confirm this is a genuine regional failure, not a transient blip:

```bash
# Global Accelerator endpoint health (primary should show UNHEALTHY, not just DEGRADED)
aws globalaccelerator describe-endpoint-group --endpoint-group-arn <eu-central-1-endpoint-group-arn>

# Aurora Global cluster status
aws rds describe-global-clusters --global-cluster-identifier idp-mvp-global --region eu-central-1
```

If the primary recovers within a few minutes, do not fail over — Global Accelerator and Route 53 health checks will route traffic back automatically. Failover is a one-way door: failing back requires re-establishing Aurora Global replication from scratch (see Rollback below).

## Failover Steps

### 1. Promote the Aurora Global secondary to a standalone writer

```bash
aws rds failover-global-cluster \
  --global-cluster-identifier idp-mvp-global \
  --target-db-cluster-identifier idp-mvp-us-east-1 \
  --region us-east-1

# Wait for promotion to complete
aws rds describe-global-clusters --global-cluster-identifier idp-mvp-global --region us-east-1 \
  --query 'GlobalClusters[0].GlobalClusterMembers[*].{Cluster:DBClusterArn,IsWriter:IsWriter}'
```

### 2. Flip the Crossplane ProviderConfig default

Per-service Crossplane claims resolve resources via the `default` `ProviderConfig` — repoint it so new claims (and any that reconcile during the incident) target us-east-1:

```bash
kubectl --context us-east-1 apply -f aws/crossplane/provider-config-us-east-1-primary.yaml
```

This does not need to run against eu-central-1 — if that cluster's API server is unreachable, skip it and clean up when the region recovers.

### 3. Cut ArgoCD hub-spoke traffic to us-east-1

The V2 ApplicationSet matrix generator (see `docs/multi-region.md` § GitOps) orders sync waves eu-central-1 (wave 0) → us-east-1 (wave 1). During failover, promote us-east-1 to wave 0 so it syncs independently of the (possibly unreachable) primary:

```bash
kubectl --context us-east-1 patch applicationset idp-platform -n argocd --type merge \
  -p '{"spec":{"generators":[{"matrix":{"generators":[{"list":{"elements":[{"region":"us-east-1","cluster":"https://eks-us-east-1.internal","priority":"primary","wave":"0"}]}}]}}]}}'
```

### 4. Shift traffic

Global Accelerator should already be failing traffic over automatically via its health checks — confirm:

```bash
aws globalaccelerator describe-accelerator --accelerator-arn <accelerator-arn> \
  --query 'Accelerator.{Status:Status,IpSets:IpSets}'
```

If traffic hasn't shifted (e.g. Route 53 health-check-based failover for a Silver-tier service), force it:

```bash
aws route53 change-resource-record-sets --hosted-zone-id <zone-id> --change-batch file://failover-to-us-east-1.json
```

### 5. Verify

```bash
# Backstage reachable via us-east-1
curl -sf https://backstage.idp.local/healthcheck

# Aurora accepting writes in us-east-1
kubectl --context us-east-1 exec -it deployment/backstage -n backstage -- \
  psql -h <us-east-1-writer-endpoint> -U backstage -c "SELECT 1;"

# ArgoCD apps synced against us-east-1
kubectl --context us-east-1 get applications -n argocd
```

## Rollback (failback to eu-central-1)

Failback is **not** the reverse of the steps above — Aurora Global replication direction has to be rebuilt:

1. Once eu-central-1 is healthy again, delete the old (now orphaned) eu-central-1 cluster from the global cluster.
2. Re-add eu-central-1 as a new Aurora Global **secondary** attached to the now-promoted us-east-1 writer, and let it fully replicate.
3. Only after replication lag is 0 do a second, planned `failover-global-cluster` back to eu-central-1.
4. Revert the Crossplane `ProviderConfig` default and the ArgoCD ApplicationSet sync-wave patch from steps 2–3 above.

Treat failback as a separate, scheduled maintenance window — not an emergency action.

## Escalation

- Failover taking > 15 min (Gold-tier RTO target, see `docs/multi-region.md` § Disaster Recovery Tiers) → open AWS Support ticket (severity: Urgent) and page the platform team lead.
- Aurora Global promotion fails or reports data loss risk → do not retry blindly; engage AWS Support before further write operations.

## Post-Incident

- Confirm the [Go-Live Readiness Checklist](../multi-region.md#go-live-readiness-checklist) items still hold (alerting on standby region, DR tier assignments) before considering the incident closed.
- Document actual RTO/RPO achieved vs. the tier target in `#incidents`.
- If this was a drill rather than a real incident, note the rehearsal in the checklist so "Failover runbook rehearsed" reflects a real, recent run.
