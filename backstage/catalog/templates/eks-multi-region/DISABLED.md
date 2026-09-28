# Disabled: eks-multi-region

Unregistered from `backstage/catalog/all-templates.yaml` on 2026-09-28. The
files stay so the template can be redesigned; `scripts/validate-catalog-templates.py`
refuses to let it be re-registered while this file exists.

## Why

Its PR merges and nothing happens:

- It writes `argocd/applicationsets/<service>.yaml`. No `argocd/` directory
  exists in the platform repo and nothing applies one — `bootstrap.sh` applies
  `aws/argocd/app-of-apps.yaml`, and no ApplicationSet watches that path.
- Even if applied, its matrix generator targets hard-coded cluster URLs
  (`https://eks-eu-central-1.internal`, `https://eks-us-east-1.internal`) that
  are not the servers registered in `aws/argocd/cluster-secrets/`, so ArgoCD
  would have no cluster to deploy to.

The requester is told their service is multi-region when it is not.

## To re-enable

Write the ApplicationSet somewhere that is applied (for example as a document
alongside `aws/argocd/app-of-apps-standby.yaml`, or give it a directory an
existing app-of-apps watches), target the clusters by the names in
`aws/argocd/cluster-secrets/` (a `clusters` generator with a label selector
rather than literal URLs), render it and kubeconform it, then delete this file
and re-add the template to `all-templates.yaml`.
