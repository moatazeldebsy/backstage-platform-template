# ADR-0001: Initial service decisions

- **Status:** Accepted
- **Date:** ${{ values.date | default("TBD") }}

## Context

${{ values.name }} was scaffolded through the IDP self-service portal using the Ruby Sinatra golden path. This
template exists specifically to give modules extracted from the Ruby monolith a clean landing spot: same
CI/CD, catalog, observability, and contract-testing conventions as every other service on the platform.

## Decision

Use the IDP golden-path Ruby/Sinatra template with the shared Helm chart (`helm/service-template`). CI/CD is
provided by the shared GitHub Actions workflow.

## Consequences

- No bespoke Helm chart to maintain.
- Service follows golden-path conventions: structured JSON logs, `/healthz`, `/ready`, `/metrics` endpoints.
- If this service was extracted from the monolith, the contract between the monolith and this service must be
  registered with `contract-mcp-server` (see `.github/workflows/contract-check.yml`) so breaking changes at the
  extraction seam are caught in CI, not in production.
- Future deviations must be recorded as follow-up ADRs.
