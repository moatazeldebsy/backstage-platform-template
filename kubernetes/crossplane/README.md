# Crossplane

Per-service cloud infrastructure provisioned via Kubernetes Claims, reconciled
by Crossplane in-cluster. Coexists with Terraform — see `docs/crossplane.md`
for the boundary (TF for foundation, Crossplane for day-2 per-service infra).

```
providers/    AWS providers + IRSA runtime config + ProviderConfig
compositions/ XRDs + Compositions: XS3Bucket, XRDSInstance, XKafkaTopic,
              XDynamoTable, XSQSQueue
```

ArgoCD owns the lifecycle. Three Applications in
`kubernetes/argocd/crossplane.yaml` install Crossplane core (Helm chart),
providers, and compositions in sync-wave order.

Claims live alongside the consuming service at `services/<name>/claims/*.yaml`
and are picked up by the existing `idp-services` ApplicationSet in
`kubernetes/argocd/app-of-apps.yaml`.

## Bootstrap order

1. `terraform apply` provisions the IRSA role
   (`terraform/iam-crossplane.tf`). Note the `crossplane_aws_role_arn` output.
2. `kubectl apply -f kubernetes/argocd/crossplane.yaml` registers the three
   Crossplane Applications with ArgoCD.
3. The ProviderConfig template references `IRSA_ROLE_ARN` — substitute the
   Terraform output before commit, or rely on `scripts/bootstrap.sh` which
   does this automatically as part of Phase 2.
4. ArgoCD owns ongoing reconciliation; subsequent edits go through Git.

## Verifying

```bash
kubectl get providers.pkg.crossplane.io
# All five: INSTALLED=True HEALTHY=True

kubectl get providerconfigs.aws.upbound.io
# default ProviderConfig present, no errors in provider pod logs

kubectl get xrds
# XS3Bucket, XRDSInstance, XKafkaTopic, XDynamoTable, XSQSQueue all Established
```
