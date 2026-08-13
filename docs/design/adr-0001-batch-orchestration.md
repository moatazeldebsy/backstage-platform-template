# ADR-0001: Where batch and pipeline work runs

**Status:** Accepted · **Date:** 2026-08-14

## Context

The platform had three ways to run work that isn't a long-lived service, and no
written rule for choosing between them. That produced a specific oddity: Argo
Workflows was installed in every environment — opt-in locally, on by default on
AWS, with an S3 artifact bucket and an IRSA role — to carry **exactly one
manifest**, a DR failover runbook. Zero `WorkflowTemplate`s, zero `CronWorkflow`s.

Meanwhile the ML training story it had been installed for was a single bare
`kind: Job`, submitted by the `idp:run-training-job` scaffolder action.

The recurring question — "should this move to Argo Workflows?" — kept being
re-litigated because the answer was never recorded.

## Decision

**Argo Workflows is for multi-step, artifact-passing, human-gated, in-cluster
work. Nothing else moves there.**

| Mechanism | Use it when | Do not use it when |
|---|---|---|
| **GitHub Actions** | The work is triggered by a source change, gates a merge, or must run for an external contributor with no cluster access | It needs in-cluster endpoints, or must pause for a human mid-run |
| **Kubernetes CronJob** | A single container on a schedule, no DAG, no artifacts | You need step ordering, per-step images, or a gate |
| **Argo Workflows** | Multiple steps with different images, artifacts passed between them, a conditional gate, or a `suspend` step for human approval | It's a single container, or it must work where Argo isn't installed |

### What this means concretely

**Stays in GitHub Actions.** All build/test/scan/image-push/GitOps promotion
(`.github/workflows/build-and-deploy.yml`, `ci.yml`, `contract-check.yml`,
`codeql.yml`, `eval.yml`). Moving CI into the cluster would trade fast PR
feedback and a well-understood secret model for nothing — and it would stop
working for anyone without cluster credentials, which for an open-source template
is most contributors.

**Stays a CronJob.** The DORA exporter, the Tech Insights exporter, and the two
flaky-test exporters. Each is one container on a schedule with no artifacts.
They must also keep working on a cluster where Argo Workflows is not installed,
which is now the default (it is part of the opt-in AI/ML layer).

**Moves to Argo Workflows.** Two `WorkflowTemplate`s, plus the DR runbook that
was already there:

- `ml-training-pipeline` — `train → evaluate → register → deploy-gate`. The
  evaluate step fails the run below a minimum accuracy, and `deploy-gate` is a
  `suspend` step. **Those two things are the entire justification**: a `Job`
  would log a bad model and exit 0, and it has nowhere to pause for a human.
- `llm-eval-pipeline` — the full nightly / pre-promotion eval matrix, which needs
  in-cluster endpoints (the MCP servers, the KAgent A2A endpoint, an in-cluster
  model server, Langfuse) that GitHub Actions cannot reach. **PR-time smoke evals
  stay in Actions**, where they gate the merge.

## Consequences

- `idp:run-training-job` submits a `Workflow` when the
  `workflowtemplates.argoproj.io` CRD is present, and **falls back to the
  original `Job`** when it is not. The fallback is not optional: Argo Workflows
  is part of the opt-in AI/ML layer, so a core-only install legitimately lacks
  it, and the scaffolder template must still work there. `IDP_TRAINING_BACKEND=job`
  forces the fallback.
- The fallback path silently loses the accuracy gate and the approval step. The
  action logs a warning saying so rather than pretending they ran.
- A single-region AWS install without `--with-ai` has no Argo Workflows, so the
  DR failover runbook is unavailable there. Acceptable — DR is a multi-region
  feature and `bootstrap-multiregion.sh` installs it — but worth knowing.
- The training pipeline runs 5 pods where the Job ran 1. Requests are modest and
  the Job fallback remains for constrained clusters.

## Alternatives considered

**Move CI into Argo Workflows** (Tekton-style). Rejected: it loses PR-time
feedback, complicates the secret model, and breaks for contributors without a
cluster.

**Move the exporters to `CronWorkflow`.** Rejected: they gain nothing from a DAG
and would acquire a hard dependency on an optional component.

**Remove Argo Workflows entirely** and keep the bare `Job`. Genuinely tempting
given it carried one manifest — but the accuracy gate and the approval step are
real requirements that a `Job` cannot express, and the DR runbook already needs
typed parameters and per-step images.

## References

- `kubernetes/argo-workflows/workflowtemplates/`
- `backstage/app/packages/backend/src/modules/idpRunTrainingJob.ts`
- `aws/argo-workflows/failover-runbook.yaml`
- `docs/multi-region.md`
