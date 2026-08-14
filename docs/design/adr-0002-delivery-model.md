# ADR-0002: How services get deployed

**Status:** Accepted · **Date:** 2026-08-13

## Context

"ArgoCD or Helm?" kept being asked because the answer was implicit. In practice
the platform already used ArgoCD ApplicationSets, but nothing said so, and the
evidence pointed both ways:

- The golden-path chart could render an Argo Rollout, but only one service in the
  entire repo opted in (`hello-service`, and only locally).
- The canary steps were hardcoded 20/50/100 in the chart, and the rollback
  thresholds hardcoded at 1% / 500ms inside the ClusterAnalysisTemplate.
- The **Enable Canary Deployments** scaffolder collected `errorRateThreshold` and
  `latencyThresholdMs` from the user and interpolated them into the *pull request
  description*. They never reached the chart. Every canary ran on the same
  1% / 500ms regardless of what was typed.
- The ten AI/MCP services were excluded from the ApplicationSets entirely and
  deployed by `helm upgrade` from `bootstrap-ai.sh` — the platform's own services
  did not take the path it sells.

## Decision

**ArgoCD ApplicationSets are the only deploy mechanism. Helm is a packaging
format, never a deploy verb in CI.**

Argo Rollouts is a first-class, fully parameterised chart feature with three
strategies: `rolling` (a plain Deployment), `canary`, and `blueGreen`.

Analysis stays **one cluster-scoped `ClusterAnalysisTemplate` taking arguments**,
not a per-service template rendered by Helm. Its PromQL carries three hard-won
corrections — the `status_code` label name, the `or vector(0)` guard, and
`clamp_min` — and duplicating that into every service release is how they
silently regress. Thresholds are per-service; the query is not.

### Why the template params never reached the chart

Not an oversight — a structural limit. A scaffolder skeleton **cannot merge into
an existing file**, so the template could only emit a `.patch` for a human to
apply by hand, and nobody did.

The fix is to give every ApplicationSet a second, *optional* values file that a
template can generate wholesale:

```yaml
valueFiles:
  - $values/services/{{path.basename}}/{{valuesFile}}
  - $values/services/{{path.basename}}/helm-values-rollout-{{env}}.yaml
ignoreMissingValueFiles: true
```

`ignoreMissingValueFiles` is mandatory. Without it, every service that has no
such file puts the entire ApplicationSet into `ComparisonError`.

## Consequences

- Image promotion stays GitOps-by-`yq`: CI writes the tag into
  `helm-values-<env>.yaml` and ArgoCD syncs. CI never runs `helm install`.
- `values.schema.json` constrains the rollout block, because `strategy:
  blue-green` produces a Rollout with **no strategy** — which Argo accepts and
  then never progresses. It now fails at `helm lint`.
- Blue-green doubles the pod count during promotion. On a single-node local
  cluster `blueGreen.previewReplicaCount: 1` is required or the preview stack
  evicts platform components.
- **Unverified and load-bearing:** that Argo Rollouts substitutes `{{args.*}}`
  inside `failureCondition` specifically. It does so in provider queries. If a
  controller version does not do it in conditions, the gate compares against a
  literal string and never fails — a silently broken safety net. Test on a
  cluster with a deliberately broken image before relying on the thresholds.

## Still outstanding

The ten AI/MCP services remain excluded from the ApplicationSets. The exclusions
are currently *correct*: CI has never built those images, so removing them
produces `ImagePullBackOff`. The order is (1) CI build matrix reaches ECR,
(2) invert `bootstrap-ai.sh` to `argocd app sync` when an Application exists,
(3) move the KAgent policy ConfigMap into GitOps, (4) delete the exclusions.

The payoff is deleting ~120 lines of ownership-conflict defence in
`bootstrap-ai.sh` that exists only because two systems fight over the same
releases.

## References

- `helm/service-template/` — `values.yaml`, `templates/rollout.yaml`, `values.schema.json`
- `kubernetes/argo-rollouts/analysis-template.yaml`
- `aws/argocd/app-of-apps.yaml`, `local/argocd/app-of-apps-local.yaml`
- `backstage/catalog/templates/canary-deployment/`
- `docs/golden-path.md` — when to choose canary vs blue-green
