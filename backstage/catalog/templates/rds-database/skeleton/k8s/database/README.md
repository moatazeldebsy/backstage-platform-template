# Database setup for ${{ values.serviceName }}

Provisioned via IDP Backstage scaffolder on $(date -u +%Y-%m-%d).

## What was created

| Resource | Details |
|----------|---------|
| Database | `${{ values.databaseName }}` on the shared RDS instance |
| Database user | `${{ values.serviceName }}` |
| AWS secret | `idp-mvp/services/${{ values.serviceName }}/database` |
| K8s secret | `${{ values.serviceName }}-db-secret` (namespace: `services`) |
| Env variable | `DATABASE_URL` |

## Apply the manifests

```bash
kubectl apply -f k8s/database/ -n services
```

Monitor the init job:

```bash
kubectl logs -f job/db-init-${{ values.serviceName }} -n services
```

## Add to your Helm values

```yaml
# helm-values.yaml
envFrom:
  - secretRef:
      name: ${{ values.serviceName }}-db-secret
```

Then redeploy:

```bash
helm upgrade --install ${{ values.serviceName }} platform/helm/service-template \
  --namespace services \
  --values helm-values.yaml
```

## Connect manually (for debugging)

```bash
# Port-forward RDS through a debug pod (requires kubectl access)
kubectl run -it --rm db-debug --image=postgres:16-alpine --restart=Never -- \
  psql "$(kubectl get secret ${{ values.serviceName }}-db-secret -n services -o jsonpath='{.data.DATABASE_URL}' | base64 -d)"
```
