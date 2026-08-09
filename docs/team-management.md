# Team Management

End-to-end guide for onboarding a new engineering team onto the IDP — from provisioning their isolated namespace to giving them a self-service Grafana folder and a scoped ArgoCD ApplicationSet.

---

## Overview

Each team gets:

| Resource | What it provides |
|---|---|
| `team-<name>` Kubernetes namespace | Isolated workload space with quota, LimitRange, NetworkPolicy |
| ArgoCD `AppProject` | Scoped sync: only that namespace, only that team's repos |
| ArgoCD `ApplicationSet` | Auto-discovers services under `teams/<name>/services/*` |
| Kyverno auto-quota | Quota generated from `idp.io/tier` namespace label |
| Namespace-scoped `SecretStore` | Access only to `/<name>/*` in AWS Secrets Manager (IRSA) |
| `idp-developer` RoleBinding | Team members can deploy + observe in their namespace |
| Grafana folder | Per-team dashboard folder via sidecar ConfigMap |

---

## Step 1 — Provision the team namespace via Backstage

Open the Backstage catalog → **Create** → search **"Provision Team Namespace"** (tagged `blessed`).

Fill in:

| Field | Example | Notes |
|---|---|---|
| Team name | `payments` | Lowercase alphanum + hyphens, 3–30 chars |
| Owner group | `group:default/payments-team` | Backstage Group entity |
| Cost center | `CC-1234` | Applied to all Crossplane resources |
| Sizing tier | `small` | Small ≤25 teams / Medium 26–75 / Large 75+ |
| GitHub org | `moatazeldebsy` | Pre-filled from setup.sh |
| Platform repo | `backstage-platform-template` | Pre-filled |
| AWS region | `us-east-1` | Must match cluster region |
| ESO IAM role ARN | *(see Step 2)* | Leave blank to skip SecretStore |

Click **Create** → a PR is opened on the platform repo at `team/payments-namespace`.

---

## Step 2 — Create the per-team IRSA role (AWS only)

Before merging the scaffold PR, provision the IAM role that allows the team's
External Secrets Operator ServiceAccount to read secrets under `/payments/*`:

```bash
cd terraform
terraform apply -var='team_eso_roles=[{name="payments",cost_center="CC-1234"}]'

# Get the role ARN output and paste it into the Backstage scaffold form
terraform output team_eso_role_arns
# → { "payments" = "arn:aws:iam::123456789012:role/team-payments-eso" }
```

Re-run the scaffold with the ARN in the **ESO IAM role ARN** field, or patch the
`secret-store.yaml` in the PR directly.

For local (Kind) development, skip this step — the `SecretStore` is omitted when
`iamRoleArn` is blank.

---

## Step 3 — Merge the scaffold PR

Merge `team/payments-namespace` on the platform repo. The `scaffold.yml` CI workflow
runs `kubectl apply -f kubernetes/teams/payments/` which creates:

```
kubernetes/teams/payments/
├── namespace.yaml          # team-payments namespace + labels
├── resource-quota.yaml     # tier-based ResourceQuota
├── limit-range.yaml        # default container requests/limits
├── network-policy.yaml     # deny-all ingress except intra-ns + monitoring
├── rbac.yaml               # deployer SA + idp-developer RoleBinding
├── argocd-project.yaml     # AppProject scoped to team-payments
├── applicationset.yaml     # scans teams/payments/services/*
├── secret-store.yaml       # namespace-scoped SecretStore (if IAM role set)
└── grafana-folder.yaml     # ConfigMap → Grafana sidecar creates folder
```

And a Backstage Group entity in `backstage/catalog/catalog-info.yaml` (all Group entities live in that one file today; `backstage/catalog/groups/` exists but is empty).

---

## Step 4 — Add services for the team

Team services follow the **`teams/<teamName>/services/<serviceName>/`** path convention:

```
teams/
└── payments/
    └── services/
        ├── orders-api/
        │   ├── helm-values-aws.yaml
        │   └── helm-values-local.yaml
        └── notifications-worker/
            ├── helm-values-aws.yaml
            └── helm-values-local.yaml
```

> **Important**: Do **not** put team service values under `services/<teamName>/`.
> `services/*` is reserved for legacy platform-owned services and is scanned by
> the global ApplicationSet. Team dirs there would create broken ArgoCD Applications.

The per-team ApplicationSet detects new service directories automatically and creates
ArgoCD Applications scoped to `team-payments` namespace + `AppProject`.

### Creating a service via scaffold

In Backstage → **Create** → pick a service template (e.g. **Node.js service**, tagged `blessed`).
In the scaffolder, the service values file path will default to `services/<name>/helm-values-aws.yaml`
(legacy path). To place it under the team path, use the **target path** field and set:
`teams/payments/services/<service-name>`.

---

## Step 5 — Store team secrets

Write secrets to AWS Secrets Manager under the team path:

```bash
aws secretsmanager create-secret \
  --name "payments/database-url" \
  --secret-string '{"DB_URL":"postgres://..."}'
```

Reference from a Kubernetes `ExternalSecret`:

```yaml
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: database-url
  namespace: team-payments
spec:
  secretStoreRef:
    name: team-payments-secrets    # the namespace-scoped SecretStore
    kind: SecretStore
  target:
    name: database-url
  data:
    - secretKey: DB_URL
      remoteRef:
        key: payments/database-url
        property: DB_URL
```

The team SecretStore can only read `/payments/*` paths — cross-team access is blocked at the IAM level.

---

## Step 6 — Crossplane resources

When a team creates a Crossplane Claim in `team-payments`, Kyverno automatically:
- **Mutates**: injects `spec.parameters.team: payments` (derived from namespace name)
- **Validates**: blocks claims with no `owner` or `costCenter`

This ensures every AWS resource created by the team is tagged `idp:team=payments` for
OpenCost showback. No manual tagging needed.

---

## Step 7 — Grafana team folder

After the PR merges, the Grafana sidecar picks up the `grafana-folder-team-payments`
ConfigMap in the `monitoring` namespace and creates a **"Team — payments"** folder.

Team members can:
1. Save dashboards to their folder via the Grafana UI
2. Create ConfigMaps labeled `grafana_folder: "Team — payments"` in `monitoring` to
   provision dashboards as code

---

## DORA metrics per team

Tag all team service repos on GitHub with topic `team:payments`. The DORA exporter
detects this and emits `dora_deploy_frequency_per_day{service="orders-api",team="payments"}`.

Alternatively, set `TEAM_MAP` in AWS Secrets Manager:
```json
{"orders-api": "payments", "notifications-worker": "payments"}
```

---

## Offboarding a team

```bash
# 1. Delete the team's services from teams/<name>/services/ (ArgoCD will prune)
# 2. Delete the namespace (cascades to all resources)
kubectl delete namespace team-payments

# 3. Remove the Terraform IAM role
terraform apply -var='team_eso_roles=[]'

# 4. Archive the scaffold PR branch or delete kubernetes/teams/payments/
# 5. Remove the Backstage Group entity from backstage/catalog/catalog-info.yaml
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| ArgoCD Application `payments-orders-api-dev` not created | Values file not at `teams/payments/services/orders-api/helm-values-aws.yaml` | Check path convention |
| `ExternalSecret` in error: `SecretStore not found` | IAM role ARN not set; SecretStore not created | Run `terraform apply` with `team_eso_roles`, re-run scaffold |
| Crossplane claim rejected: `owner is required` | Kyverno validate policy blocking | Add `spec.parameters.owner` to the claim |
| Grafana folder not appearing | Grafana sidecar not picking up ConfigMap | Check `kubectl get cm -n monitoring -l grafana_folder` |
| `team=unknown` on DORA metrics | Repo not tagged with `team:<name>` topic | Tag the repo or add to `TEAM_MAP` |
