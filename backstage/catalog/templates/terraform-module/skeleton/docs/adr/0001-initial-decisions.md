# ADR 0001 — Initial Architecture Decisions

## Status

Accepted

## Context

New Terraform module scaffolded via the IDP golden path.

## Decisions

- **Terraform version**: >= 1.5.0 — required for `check` blocks and improved moved/import support
- **Module interface**: `create` boolean gate (default `true`) — allows callers to conditionally create resources without removing the module call
- **Naming**: all resources use `var.name` as a prefix for predictable, grep-able naming
- **Tagging**: `var.tags` merged into all taggable resources — callers pass environment/team tags from outside
- **Testing**: Terratest (Go) in `tests/` — integration tests run against real infrastructure in CI
- **Docs**: terraform-docs injected into `README.md` via CI — always in sync with code

## Consequences

- The `create` flag means some outputs may be `null` when `create = false`; callers must use `try()`
- Terratest requires AWS credentials in CI; use OIDC role assumption (no long-lived keys)
