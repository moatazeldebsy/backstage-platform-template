# ADR-0001: Initial model serving decisions

- **Status:** Accepted
- **Date:** ${{ values.date | default("TBD") }}

## Context

${{ values.name }} was scaffolded through the IDP self-service portal using the ML Model Serving API golden path.

## Decision

Use the IDP ML Model Serving API template with FastAPI + Prometheus instrumentation. Framework is `${{ values.modelFramework }}`. Linked to MLflow experiment `${{ values.mlflowExperiment or "none" }}`.

## Consequences

- Model artifacts loaded from MLflow Model Registry or bundled in the container.
- Exposes standard prediction latency / throughput metrics for the Grafana `idp-ml-serving` dashboard.
- Future model upgrades should use canary deployments; record any traffic-splitting decisions as follow-up ADRs.
