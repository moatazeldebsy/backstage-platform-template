# IDP Scaling Runbook

This runbook covers when and how to move between the three reference tiers as your
organisation grows, what to apply at each step, and how to verify the outcome.

---

## Tier Reference

| Tier   | Teams  | Engineers | EKS nodes (desired) | RDS class       | Search backend | ArgoCD controllers |
|--------|--------|-----------|---------------------|-----------------|----------------|--------------------|
| Small  | ≤ 25   | ≤ 150     | 3 (t3.large)        | db.t3.medium    | Lunr (in-mem)  | 1                  |
| Medium | 26–75  | 150–750   | 6 (m5.xlarge)       | db.m5.large     | Elasticsearch  | 1 (scaled)         |
| Large  | 75+    | 750+      | 12 (m5.2xlarge)     | db.r5.xlarge    | Elasticsearch  | 3 (sharded)        |

---

## Signals to move up a tier

Move from **Small → Medium** when any of these are true:
- Backstage catalog entity count > 500
- Backstage pod CPU > 70% sustained for > 10 minutes
- ArgoCD sync queue depth > 20 apps waiting
- Team count approaches 20 (plan ahead — provisioning takes 30–60 min)

Move from **Medium → Large** when any of these are true:
- Team count approaches 60
- ArgoCD application count > 250
- EKS node group `desired_size` > 15 consistently
- RDS CPU > 60% sustained (Backstage catalog queries)

---

## Step 1 — Apply Terraform profile (infrastructure resize)

```bash
cd terraform

# Dry-run first — inspect what changes
terraform plan -var-file=profiles/medium.tfvars

# Apply (EKS node group resize is rolling, ~10 min; RDS Multi-AZ failover takes ~5 min)
terraform apply -var-file=profiles/medium.tfvars
```

Key changes per tier:
- **Small → Medium**: EKS nodes t3.large→m5.xlarge, RDS db.t3.medium→db.m5.large,
  `rds_multi_az=true` (triggers RDS modification, brief failover), Karpenter enabled.
- **Medium → Large**: EKS nodes m5.xlarge→m5.2xlarge, RDS db.m5.large→db.r5.xlarge,
  VPC CIDR expands (requires VPC replacement — plan a maintenance window).

> **Large tier VPC note**: Expanding `vpc_cidr` from `10.0.0.0/16` to `10.0.0.0/8` requires
> destroying and recreating the VPC and all dependent resources. Do this with a blue/green
> cluster approach — provision the new VPC in a separate Terraform workspace, migrate teams,
> then decommission the old one.

---

## Step 2 — Apply Helm tier values (platform service resize)

### Backstage

```bash
# Replace <tier> with small, medium, or large
helm upgrade backstage backstage/backstage \
  -n backstage \
  -f helm/values-tiers/backstage-<tier>.yaml \
  --reuse-values
```

At **Medium+**, Elasticsearch must be running before applying the medium/large values:

```bash
# Deploy Elasticsearch (one-time)
helm upgrade --install elasticsearch elastic/elasticsearch \
  -n search --create-namespace \
  --set replicas=1 \
  --set resources.requests.memory=2Gi

# Then install the ES search backend plugin in Backstage
# See backstage/packages/backend/src/index.ts — add:
# backend.add(import('@backstage/plugin-search-backend-module-elasticsearch'));
```

### ArgoCD

```bash
helm upgrade argocd argo/argo-cd \
  -n argocd \
  -f helm/values-tiers/argocd-<tier>.yaml \
  --reuse-values
```

At **Large**, controller sharding is enabled (3 replicas with round-robin algorithm).
Verify sharding is active:

```bash
argocd admin controller-info
# Should show shard assignments across 3 controller pods
```

---

## Step 3 — Onboard teams at scale (Team Namespace template)

Each new team should go through the **Provision Team Namespace** Backstage template.
It creates in one scaffold run:
- `team-<slug>` Namespace with tier label and cost tags
- ResourceQuota (Small/Medium) or LimitRange defaults (Large)
- ArgoCD AppProject scoped to the namespace
- `idp-developer` RoleBinding for team members
- `deployer` ServiceAccount for CI/CD
- Backstage Group entity (auto-registered in catalog)

Navigate to: **Backstage → Create → Provision Team Namespace**

For bulk onboarding (migration from existing namespaces), use the scaffold API directly:

```bash
# Trigger scaffold via Backstage API for each team
curl -X POST https://<backstage-url>/api/scaffolder/v2/tasks \
  -H "Authorization: Bearer $BACKSTAGE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "templateRef": "template:default/team-namespace",
    "values": {
      "teamName": "payments",
      "ownerGroup": "engineering",
      "costCenter": "CC-1234",
      "tier": "medium",
      "githubOrg": "your-org",
      "platformRepo": "backstage-platform-template"
    }
  }'
```

---

## Step 4 — Verify after tier change

### Infrastructure

```bash
# EKS nodes are the right instance type and count
kubectl get nodes -o wide

# RDS Multi-AZ is active (Medium+)
aws rds describe-db-instances \
  --query 'DBInstances[].{id:DBInstanceIdentifier,multiAZ:MultiAZ,class:DBInstanceClass}'
```

### Backstage

```bash
# Pods are healthy and replicas match tier
kubectl get pods -n backstage

# Search backend is reachable (Medium+)
kubectl logs -n backstage deploy/backstage | grep -i elasticsearch
```

### ArgoCD

```bash
# All apps are synced; no apps stuck in queue
argocd app list | grep -v Synced

# Shard distribution (Large)
argocd admin controller-info
```

### Quota policy

```bash
# Kyverno generated the quota for a test namespace
kubectl get resourcequota -n team-<slug>

# Attempt a quota-busting pod (should be denied at Medium/Small)
kubectl run quota-test --image=nginx -n team-<slug> \
  --overrides='{"spec":{"containers":[{"name":"c","image":"nginx","resources":{"requests":{"cpu":"100"}}}]}}'
```

---

## Multi-cluster topology (Large tier)

At Large scale, split into two clusters to contain blast radius:

| Cluster           | Contains                                              |
|-------------------|-------------------------------------------------------|
| `idp-platform`    | Backstage, ArgoCD, MCP servers, observability, Kyverno |
| `idp-workloads`   | All `team-*` namespaces, Crossplane, ESO              |

Steps:
1. Run `terraform apply -var-file=profiles/large.tfvars` with `cluster_name=idp-workloads`
   in a separate Terraform workspace.
2. Register the workload cluster in ArgoCD on the platform cluster:
   ```bash
   argocd cluster add <workload-kubeconfig-context>
   ```
3. Update ArgoCD ApplicationSets to target `https://<workload-cluster-api>` for team apps.
4. Update Kyverno `ClusterPolicy` to target the workload cluster (install Kyverno on workload cluster).

---

## Rollback

All changes are backward-compatible. To roll back a tier:

```bash
# Terraform: reapply the previous tier profile
terraform apply -var-file=profiles/small.tfvars

# Helm: re-apply smaller tier values
helm upgrade backstage backstage/backstage -n backstage \
  -f helm/values-tiers/backstage-small.yaml --reuse-values
```

Note: RDS instance class downgrades require a brief DB restart. EKS node group downgrades
are rolling and non-disruptive if pods fit on the smaller nodes.
