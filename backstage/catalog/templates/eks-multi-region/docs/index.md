# EKS Multi-Region Deployment (ArgoCD ApplicationSet)

Scaffold an ArgoCD ApplicationSet that deploys a service to both the
primary cluster (eu-central-1) and the standby cluster (us-east-1) using
the V2 hub-spoke matrix generator.

The ApplicationSet applies progressive delivery: eu-central-1 is synced
first; us-east-1 receives traffic only after the Argo Rollouts health gate
passes in the primary region.

## What it does

1. **Render ApplicationSet manifests** — `fetch:template`
2. **Open Pull Request to platform repo** — `publish:github:pull-request` against the platform repo

## Parameters

| Parameter | Required | Description |
|---|---|---|
| `serviceName` | yes | Kubernetes-safe service identifier (e.g. payment-api) |
| `repoUrl` | yes | The Git repository that contains the Helm chart for this service (e.g. https://github.com/myorg/payment-api) |
| `helmChartPath` | yes | Relative path to the chart directory (e.g. helm or deploy/chart) — default `helm` |
| `targetRevision` | no | Git branch / tag to track — default `main` |
| `namespace` | no | Kubernetes namespace to deploy into on both clusters — default `services` |
| `owner` | yes | Owning team |
| `primaryTrafficDial` | no | Percentage of Global Accelerator traffic routed to eu-central-1 — default `100` |
| `standbyTrafficDial` | no | Percentage of Global Accelerator traffic routed to us-east-1 (0 = warm standby) — default `0` |
| `autoSync` | no | ArgoCD will auto-sync from Git. Disable for manual promotion workflows. — default `true` |
| `pruneOrphans` | no | Prune orphaned resources — default `true` |

## How to use

1. Open Backstage → **Create**
2. Find **EKS Multi-Region Deployment (ArgoCD ApplicationSet)** and click **Choose**
3. Fill in the parameters above and click **Create**

## Source

Template definition: `template.yaml` in this template's folder under `backstage/catalog/templates/`.
