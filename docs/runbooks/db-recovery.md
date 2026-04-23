# Database Recovery Runbook

## Alert Description

Triggered when: RDS instance is unavailable, Backstage cannot connect to its Postgres database, or RDS CPU/storage is critically high.

## Impact

- **Backstage DB down:** Backstage portal is fully unavailable. Developers cannot scaffold services, view catalog, or read TechDocs.
- **Service DB down:** Any service that depends on this DB returns errors.

## Immediate Actions

### 1. Check RDS instance status

```bash
aws rds describe-db-instances \
  --db-instance-identifier idp-mvp-backstage \
  --region us-east-1 \
  --query 'DBInstances[0].{Status:DBInstanceStatus,Engine:Engine,Endpoint:Endpoint.Address}' \
  --output table
```

Expected status: `available`. If `stopped`, `rebooting`, or `modifying` — wait and recheck in 2 minutes.

### 2. Check CloudWatch metrics for the RDS instance

```bash
# CPU utilisation
aws cloudwatch get-metric-statistics \
  --namespace AWS/RDS \
  --metric-name CPUUtilization \
  --dimensions Name=DBInstanceIdentifier,Value=idp-mvp-backstage \
  --start-time $(date -u -v-30M +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --period 300 \
  --statistics Average \
  --region us-east-1

# Free storage space
aws cloudwatch get-metric-statistics \
  --namespace AWS/RDS \
  --metric-name FreeStorageSpace \
  --dimensions Name=DBInstanceIdentifier,Value=idp-mvp-backstage \
  --start-time $(date -u -v-30M +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --period 300 \
  --statistics Average \
  --region us-east-1
```

### 3. If RDS is stopped — start it

```bash
aws rds start-db-instance \
  --db-instance-identifier idp-mvp-backstage \
  --region us-east-1
```

Wait ~5 minutes for the instance to become `available`.

### 4. If RDS is unavailable — reboot

```bash
aws rds reboot-db-instance \
  --db-instance-identifier idp-mvp-backstage \
  --region us-east-1
```

### 5. Verify Backstage can reconnect

```bash
# Restart Backstage pods to force a fresh connection
kubectl rollout restart deployment/backstage -n backstage

# Watch pods come up
kubectl get pods -n backstage -w

# Check Backstage logs for DB connection errors
kubectl logs deployment/backstage -n backstage --tail=50
```

## Restore from RDS Snapshot

If the instance is corrupted or data is lost:

```bash
# List available snapshots
aws rds describe-db-snapshots \
  --db-instance-identifier idp-mvp-backstage \
  --region us-east-1 \
  --query 'DBSnapshots[*].{ID:DBSnapshotIdentifier,Time:SnapshotCreateTime,Status:Status}' \
  --output table

# Restore from the most recent snapshot to a new instance
aws rds restore-db-instance-from-db-snapshot \
  --db-instance-identifier idp-mvp-backstage-restored \
  --db-snapshot-identifier <snapshot-id> \
  --db-instance-class db.t3.micro \
  --region us-east-1 \
  --no-publicly-accessible

# Wait for the restored instance to be available (~10 min)
aws rds wait db-instance-available \
  --db-instance-identifier idp-mvp-backstage-restored \
  --region us-east-1

# Get the new endpoint
aws rds describe-db-instances \
  --db-instance-identifier idp-mvp-backstage-restored \
  --query 'DBInstances[0].Endpoint.Address' \
  --output text \
  --region us-east-1
```

Update the DB host in Secrets Manager and restart Backstage:

```bash
aws secretsmanager update-secret \
  --secret-id idp-mvp/backstage \
  --secret-string '{"POSTGRES_HOST":"<new-endpoint>","POSTGRES_PORT":"5432"}' \
  --region us-east-1

kubectl rollout restart deployment/backstage -n backstage
```

## Storage Full — Emergency Cleanup

```bash
# Connect to RDS via port-forward through a debug pod
kubectl run pg-debug --image=postgres:15 --restart=Never -n backstage -- sleep 3600
kubectl exec -it pg-debug -n backstage -- psql \
  -h <rds-endpoint> -U backstage -d backstage

-- Check table sizes
SELECT relname, pg_size_pretty(pg_total_relation_size(oid)) AS size
FROM pg_class WHERE relkind = 'r' ORDER BY pg_total_relation_size(oid) DESC LIMIT 10;

-- Vacuum to reclaim space
VACUUM FULL;
```

Alternatively, increase RDS storage via Terraform: update `allocated_storage` in `terraform/rds.tf` and run `terraform apply`.

## Escalation

- RDS unavailable for > 15 min and not recovering → open AWS Support ticket (severity: Urgent)
- Data loss suspected → engage AWS Support before any write operations

## Post-Incident

- Verify automated backups are enabled (retention: 7 days, as configured in `terraform/rds.tf`)
- Document the failure cause and restoration time in `#incidents`
- Review CloudWatch alarms for RDS storage — add a low-storage alarm to `terraform/finops.tf` if missing
