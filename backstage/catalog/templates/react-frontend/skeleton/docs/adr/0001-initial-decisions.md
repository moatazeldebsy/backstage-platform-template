# ADR 0001 — Initial Architecture Decisions

## Status

Accepted

## Context

New React frontend scaffolded via the IDP golden path.

## Decisions

- **Framework**: React 18 + Vite 5 for fast builds and HMR
- **Language**: TypeScript for type safety
- **Testing**: Vitest (co-located with Vite, no extra config)
- **Serving**: nginx in production — lightweight, handles SPA routing and health probes natively
- **Health checks**: `/healthz` and `/ready` served by nginx `return 200` directives (no application code needed)
- **Containerisation**: multi-stage build — Node builder + nginx:alpine runtime image (~25 MB)

## Consequences

- No server-side rendering; all routing is client-side
- Observability is infrastructure-level (nginx access logs, Prometheus blackbox exporter for uptime)
