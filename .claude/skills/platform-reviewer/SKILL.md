---
name: platform-reviewer
description: Review a diff against this IDP platform's specific conventions — correct IaC layer, dual local/AWS coverage, the CI gate for every touched component, scaffolder templates registered in both front doors, docs updated when behaviour is user-facing, accepted risks not re-opened. Use after /code-review (which finds general bugs) to catch the platform-specific mistakes a generic review misses.
---

# Platform Reviewer

You review changes **as this platform**, not as generic code.

**Run `/code-review` first.** It finds correctness bugs in the working diff. This skill
layers the repo's conventions on top; it does not replace it. If the caller hasn't run
it, say so and do this pass anyway.

Read `.claude/context/platform-map.md` first. `CONTRIBUTING.md` has the project's own PR
guidelines (focused PRs, verify the local platform still boots, update docs for
user-facing changes, fill the PR template).

## Get the diff

```bash
git diff main...HEAD --stat        # branch vs main
git diff --stat                    # uncommitted working diff
```

Review what changed. Do not audit untouched code — if you spot something adjacent and
serious, mention it once at the end as out-of-scope context.

## The checklist

### 1. Layer placement
Is each new resource in the layer that owns it (map §1)? The classic misses: a
per-service AWS resource added to `terraform/` instead of a Crossplane Composition, or a
cluster-scoped concern added to `helm/service-template` instead of `kubernetes/`. Two
tools managing one resource is the worst outcome — check the other side before accepting
an addition.

### 2. Dual-target coverage
Any change to `helm/service-template` or a service's values: was it checked against
**both** `helm-values-local.yaml` and `helm-values-aws.yaml`? A new chart template branch
gated on a value that only the local file sets is a bug that ships green.

### 3. CI gate per touched component
For every component in the diff, does the corresponding gate in map §2 pass? Verify — run
them. And note the coverage gap: only `contract-mcp-server` has a CI job, so changes to
the other seven MCP servers, `agent-event-router`, or `approval-service` were gated by
nobody unless the author ran the tests. Ask.

### 4. Scaffolder templates — both front doors
A new or renamed template under `backstage/catalog/templates/` must be registered in
**both** `backstage/app-config.yaml` (`catalog.locations`) **and**
`backstage/catalog/all-templates.yaml`. Run `python3 scripts/validate-catalog-templates.py`.
Also check whether `cli/internal/scaffold/` needs the matching change.

### 5. Config layer
New Backstage config in the right layer — target-specific in the overlay, not the base.

### 6. Docs
`CONTRIBUTING.md` requires docs updates for user-facing behaviour changes. Specifically:
new template → `docs/golden-path.md`; new CLI command → `docs/cli-reference.md`; new or
changed script → `docs/scripts-reference.md`; new failure mode → a runbook in
`docs/runbooks/`; changed gates → `docs/shift-left.md`.

### 7. Security regressions
Does the diff weaken a skeleton's CI security gates, widen an IAM policy, add a literal
secret, or bypass `default-deny.yaml`? Hand anything substantial to `security-advisor`.

### 8. Accepted risks stay accepted
If the diff bumps react-router, or "fixes" one of the other entries in `SECURITY.md`'s
Known Accepted Risks table, that's a finding — those decisions are measured and
documented, with named re-evaluation conditions. Reopening one needs the condition to
actually be met.

### 9. Scaffold-skeleton gotchas
If the diff touches a skeleton's CI or image naming: the image name must derive from
`repoName`, not the display `name`. Coverage gates must be validated against a *rendered*
skeleton, not the template source. Dependabot failing on a fresh skeleton is expected and
is not a finding.

## Output

One-line verdict first: **ship**, **ship with follow-ups**, or **needs changes**.

Then findings, most severe first:

- **What** — one sentence.
- **Where** — `file:line`.
- **Why it matters here** — the platform consequence: admission rejection, template
  invisible in the portal, works-on-Kind-fails-on-EKS, CLI and portal diverge.
- **Fix** — concrete, one or two sentences.

Then a short **Verified** section listing the gates you actually ran with their real
output, and a **Not verified** section naming what you couldn't check and why.

Findings only. Don't list what's fine, and don't pad a clean review.

## Delegation

For a diff over roughly ten files, or one spanning three or more components, spawn
**`platform-auditor`** with the domain and this checklist rather than reading everything
inline. For diffs touching templates, the chart, or values files, spawn
**`drift-detector`** on the relevant pair. Small diffs: just read them.
