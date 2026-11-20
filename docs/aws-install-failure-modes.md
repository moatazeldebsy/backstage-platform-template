# AWS install: known failure modes

The first real AWS bring-up (August 2026) surfaced about twenty defects. All are
fixed in the scripts, Terraform or manifests, so a fresh install gets the fixes
automatically. If your run fails, the symptom is probably below with the file that
now prevents it. For live debugging, start at [Troubleshooting](TROUBLESHOOTING.md).

## Symptoms and fixes

| Symptom | Cause | Fixed in |
|---|---|---|
| First `terraform init` fails with `AccessDenied` / `NoSuchBucket` | The backend was pinned to one account's bucket | `terraform/main.tf`, `ensure_tf_state_backend()` in `scripts/lib.sh` |
| Every node fails `NodeCreationFailure` ~20 min in | Targeting `module.eks` alone built private subnets with no NAT route | `scripts/bootstrap.sh` phase 1 targets `module.vpc` too |
| Plan fails on an empty account | The kubectl provider can't configure before the cluster exists | `bootstrap.sh` applies VPC + EKS first |
| Backstage points at `http://BACKSTAGE_ALB_URL`, KAgent links dead | Placeholder substituted in the ConfigMap but not the deployment env | `scripts/bootstrap.sh`, `scripts/bootstrap-ai.sh` |
| External Secrets ignore `--region` | Region hardcoded | `aws/backstage/external-secret.yaml` |
| GitHub/Grafana/App credentials silently missing from Secrets Manager | Credential merge nested in the wrong branch | `bootstrap.sh` phase 3.7 |
| KAgent installs, then fails on first use | `REPLACE_ME` passed a non-empty check | `scripts/verify-secrets.sh` tests for placeholders |
| Catalog has no Groups/Users; K8s tab metrics, SLOs, exporters missing on EKS | Local-only paths (bind mounts, Kind addons) never had an AWS equivalent | `aws/` manifests, `bootstrap.sh` |
| Incident agent never runs, though the incident issue is created | 5 s HTTP timeout on an LLM call (real triage takes ~40 s) | `AGENT_TIMEOUT_MS` (180 s) in `services/agent-event-router` |
| Argo Workflows install fails, or artifacts never upload | Static-credential defaults, malformed ingress paths, a missing IRSA role | `aws/` values, `module.argo_workflows_irsa` in Terraform |

## Lessons for changing the bootstrap path

- **Grep every consumer of a placeholder.** ConfigMaps and deployment envs are
  different places, and something usually reads both.
- **Check optional keys for placeholder values**, not just emptiness — see
  `scripts/verify-secrets.sh`.
- **Anything local reads from disk or a Kind addon needs an explicit AWS path.**
- **An LLM call needs a timeout an order of magnitude above an HTTP one**, and when
  it's the last step, its failure doesn't look like failure.
- **Fix it in the script, not by hand on the cluster**, then add the symptom here.

## What still is not covered

- **No CI job runs a real AWS bootstrap.** `aws-plan-check` proves the Terraform
  plans; it can't catch a runtime ordering bug, a missing IAM permission, or a bash error.
- **Services are only built by CI when they change**, via the build matrix.
- **Sloth has no in-cluster operator.** The rules are vendored; editing the source
  without the `sloth` binary does nothing. See [SRE & Reliability](sre-reliability.md).
