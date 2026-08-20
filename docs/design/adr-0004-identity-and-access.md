# ADR-0004: Identity and access

**Status:** Accepted (partial — see Deferred) · **Date:** 2026-08-14

## Context

Users and Groups are hand-written YAML in `backstage/catalog/catalog-info.yaml`:
seven Groups and fourteen Users. That drifts from reality the moment anyone else
adopts the template.

`app-config.aws.yaml` configured a `githubOrg` entity provider intended to fix
that — but `@backstage/plugin-catalog-backend-module-github-org` is not a
dependency and is not installed, so the provider block had no consumer. It looked
solved and was not.

Separately, `auth.providers` on AWS carried a `guest:` block with
`dangerouslyAllowOutsideDevelopment: true`, above a comment reading
"DEMO ONLY — not committed". It *was* committed.

## Decision

### 1. Guest auth is removed from the production config

`idpPermissionPolicy.ts` denies guests exactly three permissions
(`scaffolder.task.create`, `scaffolder.task.cancel`, `catalog.entity.delete`), so
an unauthenticated visitor could read every entity, owner, annotation and link in
the catalog — over plain HTTP, on an internet-facing ALB.

The comment made this worse than the exposure alone: it defeated review by
telling any reader the line was a local-only edit.

Local keeps guest. `app-config.local.yaml` force-enables it because `NODE_ENV` is
not `development` inside the container, and that is a laptop.

### 2. GitHub Org ingestion is deferred, not adopted

The obvious fix — install the `github-org` module and sync Users and Groups from
the organisation — **cannot work on a personal account**. The provider calls the
GraphQL `organization(login:)` API; a `type: User` account has no members and no
teams, so it errors rather than returning empty. Verified 2026-08-14 against the
account this template is developed on.

Adopting it would mean shipping a default that fails for the maintainer and works
only for org-backed adopters. Instead it stays unimplemented and documented, and
the static Groups and Users remain the seed.

### 3. Authorization stays coarse, and that is stated plainly

`idpPermissionPolicy.ts` is unchanged: any authenticated user can run any of the
64 scaffolder templates against any team's namespace. That is a real limitation
of the current design, not an oversight, and it is written here so nobody has to
rediscover it by reading the policy.

## Deferred

Each of these is tracked, none is scheduled:

- **Install and wire `githubOrg`** so Users and Groups sync from a real
  organisation. Should ship as *available and off by default*, since personal
  accounts cannot use it.
- **Team-scoped authorization** — restrict scaffolder and catalog writes to the
  owning group. Existing issues #153 (ArgoCD RBAC per team) and #155 (catalog
  permission policies) cover the shape.
- **OIDC / AWS IAM Identity Center** as the enterprise path. Heavier, and most
  open-source adopters will not have Identity Center, so GitHub remains the
  default.

## References

- `backstage/app-config.aws.yaml` — `auth.providers`
- `backstage/app/packages/backend/src/modules/idpPermissionPolicy.ts`
- `backstage/catalog/catalog-info.yaml` — the static Groups and Users
