# ADR-0004: Identity and access

**Status:** Accepted (partial — see Deferred) · **Date:** 2026-08-14
**Update 2026-09-10:** GitHub Org ingestion, deferred in Decision §2 below, has
since been adopted — see "GitHub Org ingestion adopted" after the Deferred list.

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

- ~~**Install and wire `githubOrg`** so Users and Groups sync from a real
  organisation. Should ship as *available and off by default*, since personal
  accounts cannot use it.~~ **Superseded — see "GitHub Org ingestion adopted"
  below.**
- **Team-scoped authorization** — restrict scaffolder and catalog writes to the
  owning group. Existing issues #153 (ArgoCD RBAC per team) and #155 (catalog
  permission policies) cover the shape. Still open: sign-in is now restricted
  to org members (see below), but once signed in, any authenticated user can
  still run any template against any team's namespace — `idpPermissionPolicy.ts`
  does no group-membership check.
- **OIDC / AWS IAM Identity Center** as the enterprise path. Heavier, and most
  open-source adopters will not have Identity Center, so GitHub remains the
  default.

## GitHub Org ingestion adopted (2026-09-10)

The blocker in Decision §2 — `organization(login:)` failing against a personal
GitHub account — is confirmed exactly as predicted: `moatazeldebsy` (the
account the platform repo and scaffolded services live under) is a personal
account, and the org-sync query fails against it with "Could not resolve to
an Organization with the login of 'moatazeldebsy'." GitHub does not allow
converting a personal account into an Org, so identity sync targets a
**separate** real Org, `platform-demo-idp`, created for this purpose — the
platform repo stays under `moatazeldebsy` and is unaffected.
`catalog.providers.github.idpOrg` (component/repo discovery) still points at
`moatazeldebsy`; only `catalog.providers.githubOrg` (identity sync) points at
`platform-demo-idp`. `@backstage/plugin-catalog-backend-module-github-org` is installed
and registered (`backstage/app/packages/backend/src/index.ts`), and
`catalog.providers.githubOrg.idpOrgSync` (previously inert in
`app-config.aws.yaml` only) is live in both `app-config.aws.yaml` and
`app-config.local.yaml`.

Consequences:

- **Users and Groups are synced, not hand-written.** The seven Groups and
  fourteen fictional Users formerly in `backstage/catalog/catalog-info.yaml`
  (and `qa-team`/`qa-engineer` in `qa-catalog.yaml`) are deleted. Every org
  member becomes a `User` entity; every org team becomes a `Group` entity,
  on a 30-minute schedule.
- **Cost-budget annotations survive the migration** via a `TeamTransformer`
  (`idpGithubOrgTeamMetadataModule`, registered against
  `githubOrgEntityProviderTransformsExtensionPoint`) that merges
  `idp.io/cost-budget-monthly-usd` / `idp.io/cost-namespace` onto each synced
  Group from `catalog.teamMetadata` (`app-config.yaml`), keyed by team slug.
- **Sign-in is now restricted to org members.** Both GitHub auth resolvers
  (`usernameMatchingUserEntityName`, `emailMatchingUserEntityProfileEmail`)
  flipped `dangerouslyAllowSignInWithoutUserInCatalog` from `true` to `false`
  in `app-config.yaml`, `app-config.local.yaml`, and `app-config.aws.yaml`.
  A matching `User` entity now only exists for real org members, so sign-in
  fails closed instead of falling through to an unresolved identity.
  **Caveat:** a brand-new org member can't sign in until the next sync tick
  (30 min on AWS) unless an admin triggers a manual catalog refresh.
- **`GITHUB_TOKEN` needs `read:user` (or `user:email`) in addition to
  `read:org`.** Discovered while testing this locally: the sync provider's
  GraphQL query always requests each member's email when authenticating with
  a classic PAT, and GitHub fails the whole query — not just that field —
  without the scope. See `docs/github-app-setup.md`.
- **`catalog.providers.githubOrg` config shape**: it's read directly as a
  single provider config (or an array, for multiple orgs) — nesting it one
  level deeper under a named key (as this repo's first attempt at the AWS
  block did) fails at startup with "Missing required config value at
  'catalog.providers.githubOrg.id'". `orgs` is a plain array of org-name
  strings, not `{name: ...}` objects. This is presumably *why* the block sat
  inert rather than erroring loudly before now — it was never actually run
  against the real module until this change registered it.
- **`team-namespace` creates the GitHub team**, not a hand-generated catalog
  Group YAML. The new `idp:github:team-create` scaffolder action
  (`idpGithubTeamCreate.ts`) calls the GitHub API directly (idempotent — reuses
  an existing team rather than failing); the Group entity then just appears
  from the next org sync. The template's old `catalog-skeleton/` step is
  removed.
- **Rollout requirement:** every `spec.owner: platform-team` /
  `owner: qa-platform-team` / etc. reference across the 64 scaffolder templates
  and registered services now points at what must be a *real* GitHub Team of
  that slug — these were created in the org as part of rollout (one-time,
  outside this repo) since template ownership defaults assume they exist. The
  `qa-team` name was renamed to `qa-platform-team` across the repo to match the
  slug actually chosen when the team was created in `platform-demo-idp`.
- **The `platform-demo-idp` / `moatazeldebsy` split is a personalisation
  variable, not a hardcoded value.** `scripts/placeholders.conf` gained a
  `GITHUB_TEAMS_ORG` row (placeholder `YOUR_GITHUB_TEAMS_ORG`, literal
  `platform-demo-idp`) alongside the existing `GITHUB_ORG` row (literal
  `moatazeldebsy`) — this repo is itself a GitHub template other adopters
  fork, so nothing about *this* deployment's org names may be baked in as a
  literal outside the manifest. Left blank at the `setup.sh` prompt,
  `GITHUB_TEAMS_ORG` defaults to whatever `GITHUB_ORG` resolves to (see the
  fallback in `scripts/setup.sh` and `run_personalization_pass` in
  `scripts/lib.sh` — a plain manifest row can't express "default to another
  row's resolved value", so this one needed a few lines of code instead of
  just a manifest row) — a single-org adopter never has to know this variable
  exists. Only a split setup like this one (GitHub disallows converting a
  personal account into an Org — see Decision §2 above) needs to answer it
  separately.
- Scaffolded service repos (`go-service`, `nodejs-service`, etc.) still target
  `moatazeldebsy` by default — `GITHUB_TEAMS_ORG` only drives identity sync
  (`catalog.providers.githubOrg`) and the `/admin` page's "Invite User" link
  (`externalLinks.githubOrgUrl`). The `allowedOwners` picker on every
  repo-creating template deliberately stays pointed at `moatazeldebsy` (not
  parameterised to `GITHUB_TEAMS_ORG`) — a personal account can't be an
  `allowedOwners` entry alongside a GitHub Org selector without adopters who
  never set `GITHUB_TEAMS_ORG` seeing a confusing second option that's
  identical to the first.
- **All 33 repo-creating templates now grant the owning GitHub Team
  `maintain` access** on the repo they create, via a `collaborators: [{team:
  ${{ parameters.owner }}, access: maintain}]` entry added to each template's
  `publish:github` step. `parameters.owner` is always a `kind: Group`
  `OwnerPicker` value across these templates (verified), and
  `entityRefToName()` in the scaffolder-backend-module-github action strips
  the `group:default/` prefix before calling GitHub's
  `addOrUpdateRepoPermissionsInOrg`. This only actually grants anything when
  the repo owner is an Org (`user.data.type === 'Organization'`) — for a
  personal-account repo (today's default, `moatazeldebsy`) the same call
  fails harmlessly and is caught + logged as a warning by the scaffolder
  action itself, not by anything in this repo. In other words: the grant is
  inert today (repos still go to a personal account) and takes effect the
  moment an adopter points a template's `repoUrl` at their
  `GITHUB_TEAMS_ORG`-equivalent Org instead.

## References

- `backstage/app-config.yaml`, `app-config.local.yaml`, `app-config.aws.yaml` — `auth.providers`, `catalog.providers.githubOrg`, `catalog.teamMetadata`, `externalLinks.githubOrgUrl`
- `backstage/app/packages/backend/src/modules/idpPermissionPolicy.ts`
- `backstage/app/packages/backend/src/modules/idpGithubOrgTeamMetadata.ts`
- `backstage/app/packages/backend/src/modules/idpGithubTeamCreate.ts`
- `scripts/placeholders.conf`, `scripts/setup.sh`, `scripts/lib.sh` — `GITHUB_TEAMS_ORG` personalisation
- `backstage/catalog/templates/team-namespace/template.yaml`
