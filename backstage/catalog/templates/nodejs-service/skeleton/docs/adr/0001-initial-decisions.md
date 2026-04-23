# ADR-0001: Initial service decisions

- **Status:** Accepted
- **Date:** ${{ values.date | default("TBD") }}

## Context

${{ values.name }} was scaffolded through the IDP self-service portal using the Node.js golden path.

## Decision

Use the IDP golden-path Node.js/Express template with the shared Helm chart (`helm/service-template`). CI/CD is provided by the shared GitHub Actions workflow.

## Consequences

- No bespoke Helm chart to maintain.
- Service follows golden-path conventions: structured JSON logs, `/healthz`, `/ready`, `/metrics` endpoints.
- Future deviations must be recorded as follow-up ADRs.
