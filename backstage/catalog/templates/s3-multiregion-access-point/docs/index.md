# S3 Bucket with Cross-Region Replication

Provision an S3 bucket with automatic Cross-Region Replication (CRR) to the
standby region. Objects written to the primary bucket are automatically
replicated to a replica bucket in us-east-1. Versioning is mandatory.
Optionally creates an S3 Multi-Region Access Point for a single hostname
that routes to the nearest healthy bucket.

## What it does

1. **Render claim** — `fetch:template`
2. **Open Pull Request** — `publish:github:pull-request` against the repository you choose

## Parameters

| Parameter | Required | Description |
|---|---|---|
| `bucketName` | yes | Must be globally unique. A -replica suffix bucket will also be created in the standby region. |
| `ownerService` | yes | Owning service |
| `owner` | yes | Owner |
| `primaryRegion` | no | Primary region — one of `eu-central-1`; default `eu-central-1` |
| `replicaRegion` | no | Replica region — one of `us-east-1`; default `us-east-1` |
| `multiRegionAccessPoint` | no | Single hostname that automatically routes to the nearest healthy bucket. Adds ~$0.0033/GB data transfer cost. — default `false` |
| `costCenter` | no | Cost center — default `engineering` |

## How to use

1. Open Backstage → **Create**
2. Find **S3 Bucket with Cross-Region Replication** and click **Choose**
3. Fill in the parameters above and click **Create**

## Source

Template definition: `template.yaml` in this template's folder under `backstage/catalog/templates/`.
