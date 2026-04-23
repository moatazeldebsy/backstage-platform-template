# ADR-0001: Initial agent service decisions

- **Status:** Accepted
- **Date:** ${{ values.date | default("TBD") }}

## Context

${{ values.name }} was scaffolded through the IDP self-service portal using the AI Agent golden path.

## Decision

Use the IDP AI Agent template with LangGraph + FastAPI. LLM provider is `${{ values.llmProvider }}` with model `${{ values.llmModel }}`. CI/CD is provided by the shared GitHub Actions workflow.

## Consequences

- No bespoke Helm chart to maintain.
- Service follows golden-path conventions: structured JSON logs, `/healthz`, `/ready`, `/metrics`, `/invoke` endpoints.
- MLflow is used for agent trace logging; Prometheus for metrics.
- Future deviations must be recorded as follow-up ADRs.
