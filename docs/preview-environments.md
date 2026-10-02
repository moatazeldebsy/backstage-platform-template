# PR Preview Environments

Add the **`preview`** label to a pull request in this repo that changes a deployable
service, and `.github/workflows/preview.yml` stands up a throwaway copy of it on the
EKS cluster and comments the URL on the PR.

## What happens

| PR event | Result |
|---|---|
| `preview` label added | Changed services are built at the PR's head commit, pushed to ECR as `<cluster>/<service>:pr-<number>-<sha7>`, and deployed to namespace `services-preview-<number>` |
| New commits pushed (label still set) | Rebuilt and redeployed; the PR comment is updated in place |
| PR closed or merged, or label removed | Applications deleted (cascading to everything they deployed, including the ALB), then the namespace |

A **deployable service** is `services/<name>/` with both a `Dockerfile` and a
`helm-values-aws.yaml` (`mcp-common` excluded), the same rule as everywhere else.

## How it is deployed

CI creates one ArgoCD `Application` per service, named `preview-<number>-<service>`
and labelled `idp.io/preview-pr=<number>`. It renders the same chart
(`helm/service-template`) and the same `helm-values-aws.yaml` as dev, **from the
PR's own commit**, plus a preview overlay:

- the `pr-<number>-<sha7>` image
- one replica, no autoscaling
- `environment: preview` pod label
- its own ALB (`group.name: idp-preview-<number>-<service>`, port 80), since two
  services cannot share a listener on `/`

The namespace carries the usual cost labels plus a `ResourceQuota` (1 CPU / 2 GiB
requested, 10 pods) and a `LimitRange`, so a preview cannot crowd out dev.

ArgoCD does the deploying, as for every other environment. CI only creates and
deletes `Application` objects, and nothing is committed to git.

## Limits

- **AWS only, and only while the cluster is up.** With no `AWS_ROLE_ARN` secret, or
  the stack torn down, the PR comment says so and the check stays green.
- **Same-repo PRs only.** Fork PRs get no secrets, and applying a label needs triage
  rights.
- **Cost:** one ALB per previewed service (about $0.60/day) while the preview exists.
- **Services that depend on per-namespace setup** start without it: IRSA roles that
  trust only `services-dev`, and Secrets that `bootstrap-ai.sh` creates in
  `services-dev` (most MCP servers). Previews suit stateless services, such as
  `hello-service` and what the golden-path templates scaffold.
- **`pr-*` images are not deleted** on teardown, because the CI role has no
  `ecr:BatchDeleteImage`. Add an ECR lifecycle rule for the `pr-` prefix if they
  accumulate.

## Clean up by hand

If a teardown ran while the cluster was unreachable:

```bash
kubectl delete applications -n argocd -l idp.io/preview-pr=<number>
kubectl delete namespace services-preview-<number>
```
