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

### Per-service resources (team self-service)

| Resource | XRD kind | Claim kind | Template | `idp:team` tag |
|---|---|---|---|---|
| S3 bucket | `XS3Bucket` | `S3Bucket` | `s3-bucket-crossplane` | AWS resource tag |
| RDS Postgres | `XRDSInstance` | `RDSInstance` | `rds-database-crossplane` | AWS resource tag |
| MSK topic | `XKafkaTopic` | `KafkaTopic` | `kafka-topic-crossplane` | K8s label (MSK topics don't support AWS tags) |
| DynamoDB table | `XDynamoTable` | `DynamoTable` | `dynamodb-table-crossplane` | AWS resource tag |
| SQS queue | `XSQSQueue` | `SQSQueue` | `sqs-queue-crossplane` | AWS resource tag |

### Multi-region / platform resources (V2 — platform team)

These XRDs are applied by the platform team (not individual service teams) and model
account-level or global AWS resources introduced in the `feat/v2-multi-region` branch.

| Resource | XRD kind | Claim kind | Key fields | Notes |
|---|---|---|---|---|
| ECR cross-region replication | `XECRReplicationRule` | `ECRReplicationRule` | `sourceRegion`, `destinationRegion`, `repositoryFilter` | Account-level; one claim per account |
| Route 53 health check + failover record | `XRoute53HealthCheck` | `Route53HealthCheck` | `fqdn`, `healthCheckType`, `failureThreshold`, `hostedZoneId` (opt) | DNS failover record created only when `hostedZoneId` is set |
| Global Accelerator endpoint group | `XGlobalAcceleratorEndpointGroup` | `GlobalAcceleratorEndpointGroup` | `listenerArn`, `endpointRegion`, `endpointArn`, `trafficDialPercentage` | One claim per region; set `trafficDialPercentage: 0` for warm standby |

All eight Compositions live in `aws/crossplane/compositions/`. Adding
a new resource type is a matter of dropping in another `xrd.yaml` +
`composition.yaml` pair plus a matching scaffolder template.

## Team label injection (Kyverno)

A pair of Kyverno policies in `kubernetes/policies/kyverno/crossplane-team-label-policy.yaml`
enforce cost-attribution discipline on all Crossplane claims:

**Mutate** — when a Claim is created in a `team-*` namespace, Kyverno automatically adds
`spec.parameters.team: <teamName>` (derived by stripping the `team-` prefix from the namespace).
Teams never need to set this field manually.

**Validate (Enforce)** — rejects any Claim (in any namespace) that is missing `spec.parameters.owner`
or `spec.parameters.costCenter`. This prevents untagged AWS resources that OpenCost cannot attribute.

```bash
# Verify the policies are active
kubectl get clusterpolicy crossplane-inject-team-tag crossplane-require-cost-tags

# See team tag on a provisioned S3 bucket
aws s3api get-bucket-tagging --bucket my-bucket | jq '.TagSet[] | select(.Key == "idp:team")'
```

Kyverno is installed by `bootstrap-local.sh` (Step 9b) and `bootstrap.sh` (Phase 3.8).
If you see Kyverno admission errors, verify the `kyverno-admission-controller` deployment
is `Available` in the `kyverno` namespace.

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

# XRDs established (5 per-service + 3 multi-region = 8 total)
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
