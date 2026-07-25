# Secret: ${{ values.secretKey }} for ${{ values.serviceName }}

${{ values.description }}

Rotation reminder: every **${{ values.rotationSchedule }}**.

## What was provisioned

| Resource | Location |
|----------|----------|
| AWS Secrets Manager secret | `${{ values.secretPathPrefix }}/${{ values.serviceName }}` |
| ExternalSecret CRD | `services/${{ values.serviceName }}-${{ values.secretKey | lower | replace('_', '-') }}` |
| Kubernetes secret (synced) | `services/${{ values.serviceName }}-secrets` |
| Rotation reminder workflow | `.github/workflows/secret-rotation-reminder.yml` |

## Applying the ExternalSecret

After merging this PR, the External Secrets Operator will sync the secret automatically within 1 hour.
To force an immediate sync:

```bash
kubectl annotate externalsecret ${{ values.serviceName }}-${{ values.secretKey | lower | replace('_', '-') }} \
  force-sync=$(date +%s) -n services
```

## Restarting the service

```bash
kubectl rollout restart deployment/${{ values.serviceName }} -n services
kubectl rollout status deployment/${{ values.serviceName }} -n services
```

## Rotating the secret

Every **${{ values.rotationSchedule }}**, `.github/workflows/secret-rotation-reminder.yml` opens a GitHub issue
reminding `${{ values.owner }}` to rotate this secret. To rotate:

```bash
aws secretsmanager put-secret-value \
  --secret-id ${{ values.secretPathPrefix }}/${{ values.serviceName }} \
  --secret-string '{"${{ values.secretKey }}":"NEW_VALUE"}' \
  --region ${{ values.awsRegion }}
```

The ExternalSecret will re-sync the new value on its next refresh cycle (1h).
