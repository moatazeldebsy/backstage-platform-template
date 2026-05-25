# Crossplane vs Terraform — when to use which

Both tools can provision the same AWS resource types. We split them by
**lifecycle**, not by resource family.

## TL;DR

- **Terraform** — anything that must exist before Kubernetes runs, or that
  the platform team manages once per environment.
- **Crossplane** — anything an application team requests per-service,
  through a Backstage scaffolder template, that needs continuous
  reconciliation.

## Decision matrix

| Question | If yes → use |
|---|---|
| Does it need to exist before the EKS cluster runs? | Terraform |
| Is it cluster-scoped infrastructure (VPC, IAM/OIDC, ECR)? | Terraform |
| Is it provisioned once per environment by the platform team? | Terraform |
| Is it requested per-service by an app team via Backstage? | Crossplane |
| Should drift (manual AWS-console edits) be auto-corrected? | Crossplane |
| Should it appear automatically in a service's Backstage page? | Crossplane |
| Do we want zero-`terraform apply` self-serve? | Crossplane |

## Current allocation

| Resource | Owner | Why |
|---|---|---|
| VPC, subnets, NAT | Terraform | Foundation. EKS depends on it. |
| EKS cluster + node groups | Terraform | One per environment. Lifecycle is platform-team's. |
| IAM/OIDC, GitHub Actions roles | Terraform | Bootstrap auth. Predates Crossplane install. |
| Crossplane IRSA role itself | Terraform | Chicken-and-egg: Crossplane can't bootstrap its own role. |
| ECR registries | Terraform | Created once, consumed by every CI build. |
| MSK cluster | Terraform | Heavy, shared. |
| MSK **topics** | Crossplane | Per-service. Frequent churn. |
| RDS for Backstage itself | Terraform | Bootstrapped before Backstage runs. |
| RDS **per-service** instances | Crossplane | Self-serve via scaffolder. |
| S3 / DynamoDB / SQS | Crossplane | Per-service. No bootstrap dependency. |

## IAM boundary

Terraform provisions the **single shared IRSA role** (`terraform/iam-crossplane.tf`) that all Crossplane providers assume. The role uses least-privilege **inline policies** — one per resource family — scoped to `idp-*` ARN prefixes. No `*FullAccess` managed policies are attached. See [crossplane.md § IAM](./crossplane.md#iam-least-privilege-provider-roles) for the full permission matrix.

## Deletion behaviour

Crossplane Compositions use `deletionPolicy: Orphan`. Deleting a Claim removes Crossplane's tracking of the resource but **does not delete the underlying AWS resource**. Intentional — prevents data loss from accidental `kubectl delete`. Full decommission requires a manual AWS deletion step. See [crossplane.md § Decommissioning](./crossplane.md#decommissioning-a-resource).

## The "same resource, different tool" pitfall

A Crossplane `RDSInstance` Claim and a Terraform `aws_db_instance` block
can both create RDS. Don't point them at the same instance name. The
naming convention to keep them safe:

- Terraform-managed: `${cluster_name}-<purpose>` (e.g. `idp-mvp-backstage`).
- Crossplane-managed: `<service>-<role>` (e.g. `orders-postgres`).

Reviews catch overlap before merge. The
`idp:provisioner=crossplane` / `idp:provisioner=terraform` tag on every
resource makes audits cheap.

## When to add a new Composition vs a new Terraform module

Default to **Crossplane** for any new per-service resource type. Add a
Terraform module only if:

- The resource doesn't have an upbound (or community) Crossplane provider.
- It needs to exist before Crossplane itself (rare — only Crossplane's own
  IRSA role qualifies today).
- It's a one-shot piece of shared infrastructure (e.g. a single shared NAT
  gateway, a shared Cognito user pool).

## Migrating from TF to Crossplane

Possible via `crossplane.io/external-name` annotation on the Claim, which
adopts an existing AWS resource without recreating it. Not in scope for
the first cut — propose in a follow-up.

## See also

- [crossplane.md](./crossplane.md) — architecture and end-to-end example.
