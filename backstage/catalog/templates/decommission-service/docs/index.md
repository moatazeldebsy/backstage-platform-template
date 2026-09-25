# Decommission Service

Removes a service from the IDP end to end:

1. Archives (reversible) or deletes (permanent) its GitHub repo, and strips the `idp` / `idp-*` topics so catalog discovery stops picking it up.
2. Unregisters the entity from the Backstage catalog, including the catalog location created when the service was scaffolded. Without that, an archived repo's `catalog-info.yaml` would bring the entity back on the next refresh.
3. Opens a PR in the platform repo that deletes `services/<name>/`. **Merge it.** Until you do, the `idp-services` ApplicationSet keeps deploying the service, and ArgoCD shows an app that Backstage no longer knows about. Merging prunes the Application and its workloads.

Only members of `platform-team` can run it.

## How to use

1. Open Backstage → **Create**
2. Find **Decommission Service** and click **Choose**
3. Fill in the required parameters and click **Create**

## Source

Template definition: [`template.yaml`](../template.yaml)
