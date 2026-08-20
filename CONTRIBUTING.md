# Contributing to backstage-platform-template

Thank you for your interest in contributing! This project is a community-maintained GitHub template for building Internal Developer Platforms with Backstage, Helm, and AWS EKS.

## Ways to Contribute

- **Bug reports** — open an issue using the bug report template
- **Feature requests** — open an issue using the feature request template
- **Pull requests** — improvements to templates, scripts, documentation, or new software templates
- **Documentation** — corrections, clarifications, new guides

## Local Setup

1. Clone the repo and run the one-time setup:

```bash
git clone https://github.com/moatazeldebsy/backstage-platform-template.git
cd backstage-platform-template
./scripts/setup.sh
```

2. Start the local platform:

```bash
./scripts/bootstrap-local.sh
```

See `README.md` for the full getting-started guide.

## Adding a New Software Template

1. Create a directory under `backstage/catalog/templates/<template-name>/`
2. Add `template.yaml` following the Backstage Software Templates spec
3. Add a `skeleton/` directory with the generated code
4. Register the template with a single line in `backstage/catalog/all-templates.yaml` (**not** `app-config.yaml` — it deliberately registers no templates, so local and AWS do not double-register every one). Local-only templates go in `backstage/app-config.local.yaml` instead and should carry the `local-only` tag.
5. Open a PR with a brief description of what the template generates

## Platform Skills (Claude Code)

This repo ships seven role-based skills under `.claude/skills/`. If you use
[Claude Code](https://claude.com/claude-code), they load automatically and are invokable
as slash commands. Each encodes the checklist, ownership boundaries, and exact CI
invocations for one part of the platform, so a session doesn't have to re-derive them.

| Skill | Reach for it when |
|---|---|
| `/platform-architect` | Deciding **where** a change belongs — Terraform vs Crossplane vs Helm vs `kubernetes/`, which interaction channel, which `app-config` layer, what the blast radius is |
| `/platform-engineer` | Actually building — chart edits, manifests, Terraform, MCP servers, the CLI, bootstrap scripts. Runs the per-component CI gate before calling it done |
| `/platform-reviewer` | Reviewing a diff against this platform's conventions. Run **after** `/code-review`, which covers general correctness |
| `/security-advisor` | Admission policies, PSS, network policies, IRSA/IAM, secrets, gitleaks/CodeQL, vulnerability triage |
| `/sre-responder` | Something is broken or degraded — routes symptoms to `docs/runbooks/`; also SLOs, PDBs, postmortems |
| `/golden-path-steward` | Any work under `backstage/catalog/templates/` or `cli/internal/scaffold/` — keeps the 64 templates and the CLI scaffolder in sync |
| `/qa-shift-left` | Test strategy, the Bronze/Silver/Gold scorecard, contract testing, flaky-test quarantine |

Supporting files:

- `.claude/context/platform-map.md` — shared reference all seven cite: layer ownership,
  the exact CI gate per component, the dual local/AWS rule, standing constraints.
- `.claude/agents/platform-auditor.md`, `.claude/agents/drift-detector.md` — read-only
  subagents the heavier skills delegate broad sweeps to.

**Adding an eighth:** create `.claude/skills/<name>/SKILL.md` with `name` and
`description` frontmatter (write the description with concrete trigger phrases — it's
what decides when the skill activates), give it a clear "in scope / not in scope"
boundary so it doesn't overlap an existing role, cite `.claude/context/platform-map.md`
rather than restating it, and end with the exact verification commands for its domain.
Add a row to the table above.

## Pull Request Guidelines

- Keep PRs focused — one feature or fix per PR
- Run `./scripts/bootstrap-local.sh` to verify local platform still boots
- Update documentation if your change affects user-facing behaviour
- Fill in the PR template checklist

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating you agree to abide by its terms.
