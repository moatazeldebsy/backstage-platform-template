# DynamoDB Global Table (Multi-Region)

Provision a DynamoDB Global Tables V2 table that replicates active-active
across eu-central-1 (primary) and us-east-1 (standby). Both regions can
serve reads and writes; last-writer-wins conflict resolution applies.
Requires PAY_PER_REQUEST billing.

## What it does

1. **Render claim** — `fetch:template`
2. **Open Pull Request** — `publish:github:pull-request` against the repository you choose

## Parameters

| Parameter | Required | Description |
|---|---|---|
| `tableName` | yes | Table name |
| `hashKey` | yes | Partition key |
| `hashKeyType` | no | Partition key type — one of `S`, `N`, `B`; default `S` |
| `rangeKey` | no | Sort key (optional) |
| `ownerService` | yes | Owning service |
| `owner` | yes | Owner |
| `primaryRegion` | no | Primary writer region. eu-central-1 is the platform primary. — one of `eu-central-1`; default `eu-central-1` |
| `replicaRegions` | no | Additional regions for active-active replicas. — default `['us-east-1']` |

## How to use

1. Open Backstage → **Create**
2. Find **DynamoDB Global Table (Multi-Region)** and click **Choose**
3. Fill in the parameters above and click **Create**

## Source

Template definition: `template.yaml` in this template's folder under `backstage/catalog/templates/`.
