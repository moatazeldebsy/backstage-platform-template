# RDS Database: ${{ values.dbName }}

PostgreSQL RDS instance for **${{ values.ownerService }}**.

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
# Apply Terraform (creates the RDS instance and its Secrets Manager secret)
cd terraform/infra/managed-postgres/${{ values.instanceName }}/terraform
terraform init && terraform apply
```

ArgoCD applies the ExternalSecret (`services/${{ values.ownerService }}/secrets/`)
on merge. Reference its Secret from `services/${{ values.ownerService }}/helm-values-aws.yaml`:

```yaml
envFrom:
  - secretRef:
      name: ${{ values.ownerService }}-db-secret
```

## Connection

The database credentials are synced automatically by External Secrets Operator
into the `${{ values.ownerService }}-db-secret` Kubernetes secret in `services-dev`.

Your service should consume it as an environment variable:

```yaml
# In your Helm values (helm-values-aws.yaml)
extraEnvFrom:
  - secretRef:
      name: ${{ values.ownerService }}-db-secret
```

## Rotating credentials

```bash
aws secretsmanager rotate-secret \
  --secret-id idp-mvp/${{ values.ownerService }}/db-credentials \
  --region ${{ values.awsRegion }}
```
