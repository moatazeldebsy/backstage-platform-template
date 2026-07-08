# ADR-0001: Initial service decisions

- **Status:** Accepted
- **Date:** ${{ values.date | default("TBD") }}

## Context

${{ values.name }} was scaffolded through the IDP self-service portal using the JVM/Spring Boot golden path.

## Decision

Use the IDP golden-path Java/Spring Boot + Gradle template with the shared Helm chart
(`helm/service-template`). CI/CD is provided by the shared GitHub Actions workflow.

## Consequences

- No bespoke Helm chart to maintain.
- Service follows golden-path conventions: Spring Boot Actuator health probes (`/healthz`, `/ready`),
  Micrometer/Prometheus metrics at `/actuator/prometheus`.
- Gradle (not Maven) is the default build tool for this template to standardize incremental-build tooling
  and caching across JVM services; teams needing Maven should raise it with the platform team as a deviation.
- Future deviations must be recorded as follow-up ADRs.
