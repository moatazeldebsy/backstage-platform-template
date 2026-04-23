# ADR-0001: Use Go for hello-service

- **Status:** Accepted
- **Date:** 2026-04-10

## Context

The IDP golden-path needs a reference service that demonstrates container builds, health checks, structured logging, and Prometheus metrics with minimal runtime overhead.

## Decision

Implement hello-service in Go. Go produces a single static binary, starts in milliseconds, and has first-class support for HTTP servers and Prometheus client libraries.

## Consequences

- Docker image is small (~10 MB distroless).
- Low memory footprint suits a shared local Kind cluster.
- Developers unfamiliar with Go can still read the service as a learning reference; the golden-path scaffolder also supports Node.js and Python.
