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
   Claim) **and** a `catalog-info-<bucketName>.yaml` that registers the
   resource in the Backstage Service Catalog.
3. Reviewer merges. The `idp-services` ApplicationSet in
   `aws/argocd/app-of-apps.yaml` already watches `services/*/`, so
   ArgoCD syncs the Claim within ~60 s.
4. The XRD `xs3buckets.idp.platform` matches the Claim; the Composition
   `xs3bucket.aws` creates a `Bucket`, `BucketServerSideEncryptionConfig`,
   `BucketPublicAccessBlock`, and `BucketVersioning` — all tagged
   `idp:provisioner=crossplane`, `idp:owner=<team>`, `idp:cost-center=…`.
5. `provider-aws-s3` assumes the IRSA role (`terraform/iam-crossplane.tf`,
   least-privilege inline policy scoped to `arn:aws:s3:::idp-*`) and
   creates the bucket in AWS.
6. Verify: `kubectl get s3bucket <bucketName> -n services-dev` →
   `READY=True` within ~60 s of merge.

## Resources covered

| Resource | XRD kind | Claim kind | Template | Notes |
|---|---|---|---|---|
| S3 bucket | `XS3Bucket` | `S3Bucket` | `s3-bucket-crossplane` | AES256 encrypted, public-access blocked, versioning configurable |
| RDS Postgres | `XRDSInstance` | `RDSInstance` | `rds-database-crossplane` | Encrypted at rest, connection secret auto-written, backup retention 30 days default |
| MSK topic | `XKafkaTopic` | `KafkaTopic` | `kafka-topic-crossplane` | Targets existing Terraform-managed MSK cluster via `clusterArn` |
| DynamoDB table | `XDynamoTable` | `DynamoTable` | `dynamodb-table-crossplane` | PITR on by default; supports optional sort key (`rangeKey` + `rangeKeyType`) |
| SQS queue | `XSQSQueue` | `SQSQueue` | `sqs-queue-crossplane` | SSE enabled by default; FIFO opt-in |

All five Compositions live in `aws/crossplane/compositions/`. Adding
a new resource type is a matter of dropping in another `xrd.yaml` +
`composition.yaml` pair plus a matching scaffolder template.

## IAM: least-privilege provider roles

The Crossplane IRSA role (`terraform/iam-crossplane.tf`) uses one **inline
policy per resource family**, each scoped to the minimum actions the
Composition actually performs and restricted to `idp-*` ARN prefixes:

| Policy | Key actions | ARN scope |
|---|---|---|
| `crossplane_s3` | CreateBucket, PutEncryptionConfiguration, PutBucketVersioning, … | `arn:aws:s3:::idp-*` |
| `crossplane_rds` | CreateDBInstance, DeleteDBInstance, CreateDBSubnetGroup, … | `arn:aws:rds:*:*:db:idp-*` |
| `crossplane_kafka` | CreateTopic, DeleteTopic, DescribeCluster, … | `arn:aws:kafka:*:*:cluster/idp-*/*` |
| `crossplane_dynamodb` | CreateTable, DeleteTable, UpdateContinuousBackups, … | `arn:aws:dynamodb:*:*:table/idp-*` |
| `crossplane_sqs` | CreateQueue, DeleteQueue, SetQueueAttributes, … | `arn:aws:sqs:*:*:idp-*` |
| `crossplane_tagging` | tag:TagResources, tag:GetResources, … | `*` (required by tagging API) |

> **Why `idp-*` scope?** XRD `pattern` fields enforce the same prefix on
> resource names, so a Claim can never request a name that falls outside the
> policy's resource scope.

## Safety defaults in all Compositions

| Behaviour | Value | Rationale |
|---|---|---|
| `deletionPolicy` | `Orphan` | Deleting a Claim does **not** delete the AWS resource. Prevents data loss from accidental `kubectl delete`. Manual decommission via `cleanup.sh` or AWS console required. |
| `skipFinalSnapshot` (RDS) | `false` | A final DB snapshot is taken before the instance is deleted. |
| `backupRetentionDays` (RDS) | `30` (configurable, 1–35) | Automated RDS backups retained 30 days by default. |
| `storageEncrypted` (RDS) | `true` | Always encrypted at rest. |
| `publiclyAccessible` (RDS) | `false` | VPC-only; never exposed to the internet. |
| `sqsManagedSseEnabled` (SQS) | `true` | Server-side encryption always on. |
| `pointInTimeRecovery` (DynamoDB) | `true` | PITR enabled by default. |

## Scaffolder templates

All five Crossplane templates follow the same flow:

1. Fill the form → Backstage generates a PR with two files:
   - `services/<ownerService>/claims/<name>.yaml` — the Crossplane Claim
   - `services/<ownerService>/claims/catalog-info-<name>.yaml` — Backstage Resource entity
2. Merge → ArgoCD syncs → Crossplane provisions → resource appears in catalog

**DynamoDB composite keys:** The template exposes optional `rangeKey` and
`rangeKeyType` fields. Leave them blank for hash-only tables. When set, the
Composition patches both `attribute[0]` (hash key) and `attribute[1]`
(range key) definitions — both are required by the DynamoDB API.

**Kafka `clusterArn`:** The template validates the ARN format
(`^arn:aws:kafka:`) and shows an in-form help note. To find your MSK
cluster ARN:

```bash
aws kafka list-clusters --query "ClusterInfoList[*].ClusterArn" --output text
```

## Bootstrap

```bash
# Phase 1 — Terraform provisions the IRSA role (validates ARN format before applying)
cd terraform && terraform apply
terraform output crossplane_aws_role_arn   # confirm ARN looks valid

# Phase 2 — bootstrap.sh substitutes the ARN and registers the ArgoCD stack
# (also validates the ARN starts with arn:aws:iam:: before substitution)
./scripts/bootstrap.sh
```

The `deployment-runtime-config.yaml` IRSA substitution is validated at
bootstrap time — if `terraform output` returns a non-ARN value, bootstrap
fails with a clear error rather than silently starting providers with a
broken annotation.

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
# Within ~30s, Crossplane recreates it (because deletionPolicy: Orphan
# means Crossplane still owns the desired state even if the Claim persists)
kubectl get s3bucket <bucketName> -n services-dev -w
```

## Decommissioning a resource

Because `deletionPolicy: Orphan` is set, deleting the Claim **does not**
delete the AWS resource. To fully decommission:

```bash
# 1. Delete the Claim (removes Crossplane tracking only)
kubectl delete s3bucket <bucketName> -n services-dev

# 2. Manually delete the AWS resource
aws s3 rb s3://<bucketName> --force        # S3
aws rds delete-db-instance --db-instance-identifier <id> --skip-final-snapshot  # RDS
aws dynamodb delete-table --table-name <name>   # DynamoDB
aws sqs delete-queue --queue-url <url>           # SQS

# 3. Remove the claim YAML from the repo to prevent ArgoCD re-creating it
git rm services/<ownerService>/claims/<name>.yaml
git rm services/<ownerService>/claims/catalog-info-<name>.yaml
git commit -m "chore: decommission <name>"
```

Environment teardown uses `cleanup.sh` which automates steps 2 for all
`idp:provisioner=crossplane`-tagged resources. See the
[Deployment Guide](./DEPLOYMENT_GUIDE.md#cleanup--destroy) for details.

## Local development

Crossplane runs in EKS only. The local Kind path stays unchanged — Docker-
Compose-backed Postgres/Kafka are the substitutes for local dev.
Cloud-only resources (real S3, DynamoDB, SQS) are not testable locally;
write integration tests that hit AWS or LocalStack in CI instead.

## See also

- [crossplane-vs-terraform.md](./crossplane-vs-terraform.md) — decision matrix
- `aws/crossplane/README.md` — operator notes
- `aws/crossplane/compositions/*/example-claim.yaml` — hand-rolled Claim references
