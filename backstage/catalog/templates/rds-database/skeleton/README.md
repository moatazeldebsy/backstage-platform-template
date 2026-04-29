# RDS Database: ${{ values.dbName }}

PostgreSQL RDS instance for **${{ values.serviceName }}**.

| Setting | Value |
|---------|-------|
| Instance class | `${{ values.instanceClass }}` |
| Database name | `${{ values.dbName }}` |
| Username | `${{ values.dbUsername }}` |
| Region | `${{ values.awsRegion }}` |
| Multi-AZ | `${{ values.multiAz }}` |
| Storage | `${{ values.storageGb }} GB` |

## Provisioning

After merging this PR:

```bash
# 1. Apply Terraform (creates the RDS instance)
cd terraform
terraform plan -var "cluster_name=idp-mvp"
terraform apply -var "cluster_name=idp-mvp"

# 2. Apply Kubernetes manifests (ExternalSecret + catalog entry)
kubectl apply -f services/${{ values.serviceName }}/k8s/database/

# 3. Restart service to pick up DATABASE_URL
kubectl rollout restart deployment/${{ values.serviceName }} -n services
```

## Connection

The database credentials are synced automatically by External Secrets Operator
into the `${{ values.serviceName }}-db-secret` Kubernetes secret.

Your service should consume it as an environment variable:

```yaml
# In your Helm values (helm-values-dev.yaml)
extraEnvFrom:
  - secretRef:
      name: ${{ values.serviceName }}-db-secret
```

## Rotating credentials

```bash
aws secretsmanager rotate-secret \
  --secret-id idp-mvp/${{ values.serviceName }}/db-credentials \
  --region ${{ values.awsRegion }}
```
