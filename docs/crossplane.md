# Crossplane

Crossplane provisions per-service AWS resources (RDS, S3, Kafka topics,
DynamoDB tables, SQS queues) as Kubernetes Claims, reconciled in-cluster by
ArgoCD. It coexists with Terraform — see
[crossplane-vs-terraform.md](./crossplane-vs-terraform.md) for the boundary.

## Why both

Terraform stays the right tool for the foundation: VPC, EKS cluster,
IAM/OIDC, ECR registries, anything that must exist *before* Kubernetes is
running. One-shot, platform-team-owned, applied from outside the cluster.

Crossplane is the right tool for day-2, app-team-requested infra. Claims
live in Git alongside the service that consumes them, ArgoCD syncs on
merge, Crossplane reconciles continuously, and drift is corrected without a
human running `terraform apply`. No manual step between "PR merged" and
"resource exists".

## End-to-end example: provisioning an S3 bucket

```
┌──────────────┐    PR      ┌────────────┐   sync   ┌──────────────┐
│  Backstage   │──────────▶ │   GitHub   │ ───────▶ │   ArgoCD     │
│  scaffolder  │            │ (platform  │          │ (in-cluster) │
│ s3-bucket-   │            │   repo)    │          │              │
│ crossplane   │            └────────────┘          └──────┬───────┘
└──────────────┘                                           │ apply
                                                           ▼
                                                  ┌─────────────────┐
                                                  │  S3Bucket Claim │
                                                  │      (CR)       │
                                                  └────────┬────────┘
                                                           │ reconcile
                                                           ▼
                                                  ┌─────────────────┐
                                                  │  Crossplane +   │
                                                  │ provider-aws-s3 │
                                                  └────────┬────────┘
                                                           │ IRSA
                                                           ▼
                                                  ┌─────────────────┐
                                                  │  Real S3 bucket │
                                                  │      in AWS     │
                                                  └─────────────────┘
```

1. Engineer opens the Backstage portal, picks the **S3 Object Bucket
   (Crossplane)** template, fills in `bucketName`, `ownerService`, region,
   versioning, cost center.
2. Backstage opens a PR adding
   `services/<ownerService>/claims/<bucketName>.yaml` (an `S3Bucket`
   Claim).
3. Reviewer merges. The `idp-services` ApplicationSet in
   `kubernetes/argocd/app-of-apps.yaml` already watches `services/*/`, so
   ArgoCD syncs the Claim within ~60 s.
4. The XRD `xs3buckets.idp.platform` matches the Claim; the Composition
   `xs3bucket.aws` creates a `Bucket`, `BucketServerSideEncryptionConfig`,
   `BucketPublicAccessBlock`, and `BucketVersioning` — all tagged
   `idp:provisioner=crossplane`, `idp:owner=<team>`, `idp:cost-center=…`.
5. `provider-aws-s3` assumes the IRSA role
   (`terraform/iam-crossplane.tf`) and creates the bucket in AWS.
6. Verify: `kubectl get s3bucket <bucketName> -n services-dev` →
   `READY=True` within ~60 s of merge.

## Local development

Crossplane runs in EKS only. The local Kind path stays unchanged — docker-
compose-backed Postgres/Kafka are the substitutes for local dev.
Cloud-only resources (real S3, DynamoDB, SQS) are not testable locally;
write integration tests that hit AWS or LocalStack in CI instead.

## Resources covered

| Resource | XRD kind | Claim kind | Template |
|---|---|---|---|
| S3 bucket | `XS3Bucket` | `S3Bucket` | `s3-bucket-crossplane` |
| RDS Postgres | `XRDSInstance` | `RDSInstance` | `rds-database-crossplane` |
| MSK topic | `XKafkaTopic` | `KafkaTopic` | `kafka-topic-crossplane` |
| DynamoDB table | `XDynamoTable` | `DynamoTable` | `dynamodb-table-crossplane` |
| SQS queue | `XSQSQueue` | `SQSQueue` | `sqs-queue-crossplane` |

All five Compositions live in `kubernetes/crossplane/compositions/`. Adding
a new resource type is a matter of dropping in another `xrd.yaml` +
`composition.yaml` pair plus a matching scaffolder template.

## Bootstrap

```bash
# Phase 1 — Terraform (provisions IRSA role)
cd terraform
terraform apply
terraform output crossplane_aws_role_arn

# Phase 2 — substitute the role ARN into the runtime config and apply the
# ArgoCD stack. scripts/bootstrap.sh does this automatically.
ROLE_ARN=$(terraform output -raw crossplane_aws_role_arn)
sed "s|IRSA_ROLE_ARN|${ROLE_ARN}|g" \
  kubernetes/crossplane/providers/deployment-runtime-config.yaml \
  | kubectl apply -f -
kubectl apply -f kubernetes/argocd/crossplane.yaml
```

## Verifying

```bash
# All five providers Healthy
kubectl get providers.pkg.crossplane.io

# XRDs established
kubectl get xrds

# ProviderConfig default present
kubectl get providerconfigs.aws.upbound.io

# Provider Pod has the IRSA role annotation
kubectl get pods -n crossplane-system -l pkg.crossplane.io/provider \
  -o jsonpath='{.items[*].spec.serviceAccountName}'
```

## Drift correction

Crossplane reconciles continuously. To prove it:

```bash
# Delete the bucket directly in AWS (or via kubectl)
aws s3 rb s3://<bucketName> --force
# Within ~30s, Crossplane recreates it
kubectl get s3bucket <bucketName> -n services-dev -w
```

## See also

- [crossplane-vs-terraform.md](./crossplane-vs-terraform.md) — decision matrix
- `kubernetes/crossplane/README.md` — operator notes
- `kubernetes/crossplane/compositions/*/example-claim.yaml` — hand-rolled Claim references
