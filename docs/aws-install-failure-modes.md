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
and several more once the agent starts calling MCP tools.

Measured on the live `incident-agent` rather than guessed:

| Prompt | Time |
|---|---|
| Trivial, no tool calls | **4.3s** |
| Real triage, multi-tool | **42.9s** |

So 5s aborted even the trivial case, by a 700ms margin.

**60s was tried next and still failed.** KAgent's `message/send` is synchronous
and concurrent alerts serialise: two alerts 35s apart put the second past the
limit while the first was still thinking. That is the behaviour under any alert
burst, which is exactly when incident triage matters.

**The failure was near-invisible.** The incident issue is created *before*
dispatch, so the pipeline still produced its most visible artefact while the
agent half silently never ran. Nothing was marked failed.

Agent dispatch now has its own `AGENT_TIMEOUT_MS` (default **180s** — a
multi-tool turn plus a couple queued behind it), and an abort logs which agent
timed out and that the record was still created, instead of a bare
`DOMException`.

**That is a mitigation, not the fix.** The real fix is to stop awaiting the whole
agent turn in a webhook handler — the router's job is to dispatch, not to wait
for an LLM to finish. Left as a follow-up rather than done blind.

**The general lesson:** a timeout tuned for an HTTP API is wrong for an LLM call
by an order of magnitude, and when the slow call is the *last* step its failure
does not look like failure.

### Argo Workflows: four faults behind one install that had never run on AWS

Until 2026-08-16 nothing installed Argo Workflows during `bootstrap-ai.sh`, so
the live cluster had no `argo-workflows` namespace and the AWS values file had
never been rendered against a real cluster. The first real run failed four
times in a row, each on a different fault:

1. **`nil pointer evaluating interface {}.key`.** The chart's
   `useStaticCredentials` defaults to `true`, and its config-map template then
   dereferences `artifactRepository.s3.accessKeySecret.key` unconditionally.
   With IRSA there is no such secret. Fix: `useStaticCredentials: false` plus
   `artifactRepository.s3.useSDKCreds: true`.
2. **`spec.rules[0].http.paths[0].path: Invalid value: "map[path:/ pathType:Prefix]"`.**
   `server.ingress.paths` is a list of path *strings* with `pathType` as a
   sibling scalar, not a list of objects.
3. **An ingress host that can never resolve.** The values file built its host as
   `argo-workflows.${BACKSTAGE_ALB_URL}` — a subdomain prefixed onto an ALB's
   own DNS name. The ALB was provisioned and every request missed the rule.
   Every other public ingress on this platform renders `HOSTS=*`; this one now
   does too, which also deletes a placeholder from the substitution chain.
4. **`argo_workflows_role_arn` does not exist.** `bootstrap.sh` had been reading
   that Terraform output since the feature was written, and there is no such
   output and no Argo Workflows IAM role in `terraform/`. It resolved to empty
   every time, so S3 artifact upload has never worked — and
   `kubernetes/argo-workflows/rbac.yaml` ships a literal
   `REPLACE_WITH_ARGO_WORKFLOWS_ROLE_ARN` whose comment claims the bootstrap
   patches it. Nothing did. The install now disables `archiveLogs` when the ARN
   is missing (otherwise every workflow fails trying to upload its logs) and
   *removes* the annotation rather than leaving a placeholder that reads as a
   configured role. The Terraform role is tracked in [#357](https://github.com/moatazeldebsy/backstage-platform-template/issues/357).

**The general lesson**, and it is the same one as the approval gate in
`docs/agent-approvals.md`: an install path that has never run is not "probably
fine", and a placeholder that nothing substitutes is indistinguishable from a
real value until something tries to use it. Three of these four faults were
invisible to `helm lint`, CI, and every dashboard.

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
