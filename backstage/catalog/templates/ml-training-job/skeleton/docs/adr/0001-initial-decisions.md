# ADR-0001: Initial training job decisions

- **Status:** Accepted
- **Date:** ${{ values.date | default("TBD") }}

## Context

${{ values.name }} was scaffolded through the IDP self-service portal using the ML Training Job golden path.

## Decision

Use the IDP ML Training Job template. Framework is `${{ values.modelFramework }}`. Runs are tracked in MLflow experiment `${{ values.mlflowExperiment }}` and orchestrated by Argo Workflows.

## Consequences

- All runs logged to MLflow; no ad-hoc experiment tracking.
- Job is containerised and reproducible via the provided `Dockerfile`.
- Future algorithm or framework changes should be recorded as follow-up ADRs.
