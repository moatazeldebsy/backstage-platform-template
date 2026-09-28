# Disabled: eks-cluster

Unregistered from `backstage/catalog/all-templates.yaml` on 2026-09-28. The
files stay so the template can be redesigned; `scripts/validate-catalog-templates.py`
refuses to let it be re-registered while this file exists.

## Why

Its repository picker only allows `backstage-platform-template`, and its PR
writes the skeleton at the repository root: `terraform/main.tf`,
`terraform/variables.tf`, `terraform/outputs.tf`, `terraform/addons.tf` and
`catalog-info.yaml`. Those paths already hold the platform's own EKS/VPC/IAM
root module and its root catalog entity, so the PR replaces them. Merging it
and applying would reshape (or destroy) the platform cluster rather than
create a new one.

## To re-enable

Write the cluster to its own root — for example
`terraform/clusters/<clusterName>/` via a `targetPath` on the fetch step — with
its own catalog entity file name, render it, `terraform validate` and
`terraform fmt -check` the result (its `variables.tf` renders `addons` with
`| dump`, which is not fmt-clean), then delete this file and re-add the
template to `all-templates.yaml`.
