# Secret: ${{ values.secretKey }} for ${{ values.serviceName }}

${{ values.description }}

## What was provisioned

| Resource | Location |
|----------|----------|
| AWS Secrets Manager secret | `${{ values.secretPathPrefix }}/${{ values.serviceName }}` |
| ExternalSecret CRD | `services/${{ values.serviceName }}-${{ values.secretKey | lower | replace('_', '-') }}` |
| Kubernetes secret (synced) | `services/${{ values.serviceName }}-secrets` |

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

To rotate the value, update it in AWS Secrets Manager and the ExternalSecret will re-sync on the next refresh cycle (1h):

```bash
aws secretsmanager put-secret-value \
  --secret-id ${{ values.secretPathPrefix }}/${{ values.serviceName }} \
  --secret-string '{"${{ values.secretKey }}":"NEW_VALUE"}' \
  --region ${{ values.awsRegion }}
```
