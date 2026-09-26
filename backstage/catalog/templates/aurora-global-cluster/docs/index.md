# Aurora Global Database (Multi-Region)

Provision an Aurora PostgreSQL Global Database with a primary writer in
eu-central-1 and a read replica in us-east-1 (RPO < 1s, RTO < 1min).
This template generates the Terraform variable file and PR for the
platform team to apply via the global Terraform module.

Note: Aurora Global Database is a platform-level resource provisioned
by the infrastructure team via Terraform (not Crossplane). This template
creates the request PR and Terraform tfvars file.

## What it does

1. **Render Terraform variables** — `fetch:template`
2. **Open Pull Request to platform repo** — `publish:github:pull-request` against the platform repo

## Parameters

| Parameter | Required | Description |
|---|---|---|
| `clusterName` | yes | Unique identifier for the Aurora Global cluster (e.g. my-service-db) |
| `dbName` | yes | Database name — default `appdb` |
| `instanceClass` | no | Instance class — one of `db.r6g.large`, `db.r6g.xlarge`, `db.r6g.2xlarge`, `db.r8g.large`, `db.r8g.xlarge`; default `db.r6g.large` |
| `engineVersion` | no | PostgreSQL engine version — one of `16.4`, `16.3`, `15.8`; default `16.4` |
| `owner` | yes | Requesting team |
| `requestReason` | yes | Explain why active-standby replication is needed (e.g. compliance, DR SLA) |

## How to use

1. Open Backstage → **Create**
2. Find **Aurora Global Database (Multi-Region)** and click **Choose**
3. Fill in the parameters above and click **Create**

## Source

Template definition: `template.yaml` in this template's folder under `backstage/catalog/templates/`.
