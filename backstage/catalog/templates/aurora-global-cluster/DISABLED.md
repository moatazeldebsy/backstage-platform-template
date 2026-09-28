# Disabled: aurora-global-cluster

Unregistered from `backstage/catalog/all-templates.yaml` on 2026-09-28. The
files stay so the template can be redesigned; `scripts/validate-catalog-templates.py`
refuses to let it be re-registered while this file exists.

## Why

The template does not create a database for the requester. It writes
`terraform/global/tfvars/<name>.tfvars` and tells the platform team to run

    terraform -chdir=terraform/global apply -var-file=tfvars/<name>.tfvars

`terraform/global/aurora-global.tf` defines exactly one Aurora Global cluster
with fixed identifiers (`idp-mvp-global`, `idp-eu-central-1-backstage`,
`idp-us-east-1-backstage`) — the platform's own Backstage database. The tfvars
set `rds_db_name = "appdb"` and `rds_username = "appdb_admin"` where the
platform uses `backstage`/`backstage`, and both are force-new on
`aws_rds_cluster`: following the instructions would destroy and recreate the
Backstage database. A second request would reconfigure the same cluster again.

## To re-enable

Redesign it to produce its own Terraform root (for example
`terraform/infra/aurora-global/<name>/`, like `rds-database` does for single-region
Postgres) with identifiers derived from the requested name, validate the
rendered module, then delete this file and re-add the template to
`all-templates.yaml`.
