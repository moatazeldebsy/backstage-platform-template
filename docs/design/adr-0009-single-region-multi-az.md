# ADR-0009: Single-region, multi-AZ — drop the active-standby multi-region topology

**Status:** Accepted · **Date:** 2026-10-01

## Context

The platform shipped an opt-in "V2" multi-region topology behind
`scripts/bootstrap-multiregion.sh`: eu-central-1 primary, us-east-1 warm
standby, with Aurora Global, Global Accelerator, CloudFront, Transit Gateway,
cross-region ECR / S3 / Secrets Manager replication, Thanos and a hub-spoke
ArgoCD. Its stated target was RTO < 15 min / RPO < 1 s for platform-core
("Gold") services.

Three things made that target a poor fit for what this repo actually deploys:

- **What an outage costs.** The workloads are an Internal Developer Platform —
  Backstage, ArgoCD, the MCP servers, observability. When they are down,
  developers wait; product traffic keeps flowing on the clusters those teams
  deploy to. A 15-minute regional RTO is a customer-facing SLA bought for an
  internal tool.
- **Cost and operational load.** A second full region (EKS, Aurora Global
  writer/reader, Global Accelerator, Transit Gateway, inter-region transfer) is
  roughly 2–2.5× the AWS bill of one region, plus failover drills, two clusters
  to upgrade, replication lag to monitor and a hub-spoke ArgoCD to reason about.
- **Data residency.** The design replicated EU data to us-east-1. The
  topology's own go-live checklist required legal sign-off on that transfer
  path before production use; that sign-off never existed.

Removing it also surfaced defects that were affecting *single-region* installs:

- `terraform/secrets.tf` defaulted `is_primary_region = true` and
  `secondary_region = "us-east-1"`, so every single-region apply created
  us-east-1 replicas of six secrets — and failed outright when `aws_region`
  itself was us-east-1.
- The Crossplane compositions rendered their "multi-region only" resources for
  every claim (DynamoDB `replicaRegions` defaulted to `["us-east-1"]`), targeting
  a `us-east-1` ProviderConfig single-region never installs.
- `enable_multi_az_nat = true` was set only in the multi-region tfvars, so every
  single-region install ran a single NAT gateway — an AZ-level single point of
  failure for all private-subnet egress.

## Decision

**One AWS region, resilient across Availability Zones. The multi-region
topology is removed, not kept as an option.**

Keeping it opt-in was considered and rejected: unexercised failover code rots,
and it was already leaking into the default path (above). A deleted feature
cannot be half-on.

Multi-AZ is made the production default rather than an accident of which tfvars
file was used:

| Layer | How it survives an AZ loss |
|---|---|
| VPC | Subnets across 3 AZs (`terraform/vpc.tf`) |
| Egress | One NAT gateway per AZ — `enable_multi_az_nat = true` in `profiles/medium` and `profiles/large` |
| EKS nodes | Managed node group / Karpenter spread across the 3 private subnets |
| Workloads | PodDisruptionBudgets + replicas ≥ 2, spread across zones, for platform-core services — on medium/large: ArgoCD HA overlay (`aws/argocd/argocd-ha-values.yaml`) and 2 Backstage replicas, set by `bootstrap.sh` from the profile. Grafana is still single-replica (sessions live in a per-pod SQLite DB) |
| Database | RDS Multi-AZ standby for Backstage, Langfuse and LiteLLM — `rds_multi_az = true` in `profiles/medium` and `profiles/large`; storage autoscaling so a full volume never turns a DB read-only |
| AWS APIs from pods | S3 gateway endpoint always; ECR / STS / Secrets Manager / Logs interface endpoints on medium/large, so image pulls, IRSA and secret sync do not depend on any NAT gateway |
| Object storage, ECR, Secrets Manager | Regional services, multi-AZ by design |

`profiles/small` keeps a single NAT and single-AZ RDS deliberately: it is the
cost-optimised dev tier. Profiles are applied with `./scripts/bootstrap.sh --profile
<small|medium|large>`; a run with no profile uses `terraform.tfvars` alone, which
means one shared NAT gateway.

## Consequences

| Failure | Covered? | Recovery |
|---|---|---|
| Pod / node | ✅ | Automatic (Kubernetes rescheduling) |
| One Availability Zone | ✅ on medium/large | Automatic (per-AZ NAT, RDS failover, pod rescheduling) |
| Whole region | ❌ | Rebuild from IaC + restore from backups — RTO measured in hours |

- AWS spend and operational surface drop substantially; there is one cluster to
  upgrade and one ArgoCD to reason about.
- No EU→US data transfer path exists any more.
- Existing single-region stacks will see, on their next `terraform apply`, the
  deletion of the six us-east-1 secret replicas and (on medium/large) the
  addition of per-AZ NAT gateways. Both are expected.
- Crossplane XRDs lose the V2 fields (`crossRegionReplication`, `globalTable`,
  `replicaRegions`, `globalDatabase`, `multiRegionAccessPoint`, …). Claims that
  set them must drop those fields.

### If regional DR is ever required

Reach for **backup-and-restore to a second EU region** (e.g. eu-west-1) before
reintroducing a warm standby: AWS Backup cross-region copies of RDS snapshots,
S3 replication for Terraform state and TechDocs, ECR replication. That gives an
RTO of hours at near-zero standing cost and keeps data in the EU. Only a
customer-facing workload with a contractual regional SLA justifies going
further than that.
