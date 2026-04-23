# ADR 0001 — Initial Architecture Decisions

## Status

Accepted

## Context

New Go service scaffolded via the IDP golden path.

## Decisions

- **Language**: Go 1.22 — stdlib `net/http` only, no framework dependency
- **Logging**: `log/slog` (stdlib, structured JSON to stdout)
- **Metrics**: hand-rolled Prometheus text format — no client library needed for basic info metrics
- **Graceful shutdown**: SIGTERM/SIGINT → 30 s drain window
- **Runtime image**: `gcr.io/distroless/static-debian12:nonroot` — no shell, no package manager, runs as nonroot

## Consequences

- Zero external dependencies keeps `go mod tidy` trivial and supply-chain risk minimal
- Distroless image requires all assets compiled into the binary (no shell scripts in container)
- Add `github.com/prometheus/client_golang` if richer metrics (histograms, gauges) are needed later
