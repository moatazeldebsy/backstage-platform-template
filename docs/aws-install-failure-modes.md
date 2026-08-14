# AWS install: known failure modes

The AWS path went effectively untested between May and 2026-08-11. Bringing a real
cluster up over the following days surfaced roughly twenty distinct defects. Every
one of them is fixed **in the scripts, Terraform, or manifests** — none was a
manual workaround — so a fresh install gets the fixes automatically.

This page exists for two reasons. If your run fails, the symptom is probably here
along with the file that was supposed to prevent it. And if you are changing the
bootstrap path, these are the shapes of mistake it has actually made, which is more
useful than a checklist of things that have never gone wrong.

For live debugging start with [TROUBLESHOOTING.md](TROUBLESHOOTING.md); this page is
about *why* each class of failure was possible.

---

## The classes

### 1. Placeholders that were never substituted

The most common defect by a wide margin. A manifest ships with a literal token, and
either nothing substitutes it or the substitution targets a different file.

| Symptom | Cause | Fixed in |
|---|---|---|
| First `terraform init` fails with `AccessDenied` / `NoSuchBucket` | `main.tf` pinned the backend to the maintainer's own bucket. Not a `YOUR_*` token, so `placeholders.conf` never rewrote it | `terraform/main.tf`, `ensure_tf_state_backend()` in `scripts/lib.sh` |
| `terraform/global` could never initialise | Its bucket name had a different shape from anything the repo creates | `terraform/global/main.tf` |
| Backstage pods point at `http://BACKSTAGE_ALB_URL`, KAgent links dead, Datadog shows version `BACKSTAGE_IMAGE_TAG` | `bootstrap.sh`'s `sed` matched only the `image:` line; `bootstrap-ai.sh` patched the *ConfigMap*, but the scaffolder reads the *deployment env* | `scripts/bootstrap.sh`, `scripts/bootstrap-ai.sh` |
| External Secrets always resolved against `us-east-1` regardless of `--region` | Region hardcoded in the manifest | `aws/backstage/external-secret.yaml` |

**If you are adding a placeholder:** grep for every consumer of the value before
assuming one substitution covers it. Config maps and deployment envs are different
places, and something usually reads both.

### 2. Cold-account Terraform ordering

An empty account is a different environment from one that already has a cluster,
and the difference is not cosmetic.

- The `alekc/kubectl` provider (used for the Karpenter `EC2NodeClass`/`NodePool`
  manifests) cannot configure itself while `module.eks.cluster_endpoint` is
  unknown. It fails the entire plan before creating anything, so a single
  untargeted apply **cannot** bootstrap an empty account. `bootstrap.sh` therefore
  applies `module.vpc` + `module.eks` first.
- `module.vpc` must be targeted **explicitly** alongside `module.eks`. `-target`
  pulls in only what the target depends on, and the cluster depends on subnet IDs —
  not on the NAT gateway, its EIP, or the private route tables. Targeting
  `module.eks` alone builds a cluster whose private subnets have no `0.0.0.0/0`
  route, and every node fails `NodeCreationFailure: Instances failed to join the
  kubernetes cluster` about twenty minutes in.
- Detecting "cold start" by `terraform state list` returning nothing is wrong: a
  stale lock, expired credentials and an unreachable backend all produce empty
  output too. `bootstrap.sh` fails closed when the state cannot be *read*.

All three live in `scripts/bootstrap.sh`, Phase 1.

### 3. Control flow that silently discarded configuration

- The Phase 3.7 credential merge was nested inside the `else` of a `GITHUB_TOKEN`
  check, so when a token *was* present it discarded `AUTH_GITHUB_*`,
  `GRAFANA_ADMIN_PASSWORD`, five `GITHUB_APP_*` values and `TEAM_MAP`, and never
  generated `BACKSTAGE_CATALOG_TOKEN` or `AUTH_SESSION_SECRET`.
- `--skip-obs` was parsed and never read.
- `poll_until` called an undefined `info()` for three of its four callers.

### 4. Placeholder values that passed a non-empty check

`REPLACE_ME` is not empty, so `[[ -n "$KEY" ]]` accepts it. KAgent installed
"successfully" against a placeholder Anthropic key and failed at first use. Any
check on an optional key must test for the placeholder explicitly — see
`scripts/verify-secrets.sh` for the pattern.

### 5. Things that were never installed on AWS at all

Each of these worked locally and was assumed to work on EKS:

- `metrics-server` (not installed on EKS; also needed a control-plane SG path)
- Sloth SLO rules
- The catalog and Tech Insights exporters
- Groups and Users — seventeen `type: file` catalog locations resolved to nothing
  in the container, leaving the catalog with zero `Group`/`User` entities
- A GitHub token for Backstage, without which catalog, scaffolder and TechDocs
  cannot start

**The pattern:** local uses a bind mount and a Kind-specific path; EKS has neither.
Anything that reads from disk or assumes a local addon needs an explicit AWS path.

### 6. Over-broad IAM

The GitHub Actions OIDC trust policy was scoped `repo:<org>/*:*` — PowerUser plus
IAMFullAccess for *every* repository in the org, including every scaffolded service.
Now scoped to `var.platform_repo`.

---

### 8. A 5-second timeout on an LLM call

Found by firing a synthetic critical alert through the incident pipeline on the
live cluster, then reading the router log rather than trusting the outcome.

The GitHub incident issue was created correctly — right labels, right marker. The
log said otherwise:

```
alertmanager routing error: DOMException [AbortError]: This operation was aborted
  at async postToAgent (file:///app/dist/index.js:64:22)
```

`agent-event-router` used one `HTTP_TIMEOUT_MS` (default **5000ms**) for every
outbound call, including the KAgent A2A dispatch. That dispatch is an LLM turn,
and several more once the agent starts calling MCP tools. Measured against the
live `incident-agent`, a single-sentence answer with no tool calls took **4.3s** —
passing by 700ms, with any real triage aborting.

**The failure was near-invisible.** The incident issue is created *before*
dispatch, so the pipeline still produced its most visible artefact while the
agent half silently never ran. Nothing was marked failed.

Agent dispatch now has its own `AGENT_TIMEOUT_MS` (default 60s), and an abort
logs which agent timed out and that the record was still created, instead of a
bare `DOMException`.

**The general lesson:** a timeout tuned for an HTTP API is wrong for an LLM call
by an order of magnitude, and when the slow call is the *last* step its failure
does not look like failure.

## What still is not covered

Being explicit about the gaps, because a green CI run should not imply more than it
proves:

- **No CI job runs an actual AWS bootstrap.** `aws-plan-check` validates that the
  Terraform configuration parses, resolves and plans; it cannot catch a runtime
  ordering bug, a missing IAM permission, or anything in the ~4,500 lines of bash.
- **Ten of the eleven services have never been built by CI.** The build matrix now
  covers them, but that only exercises on a change under `services/<name>/`.
- **Sloth has no in-cluster operator.** The CRD is inert and the rules are vendored;
  editing the source without the `sloth` binary on PATH silently does nothing. See
  `docs/sre-reliability.md`.

## If you hit something new

Fix it in the script, not by hand on the cluster — a manual fix leaves the next
person with the identical failure. Then add the symptom here.
