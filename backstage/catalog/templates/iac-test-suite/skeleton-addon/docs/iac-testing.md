# IaC Test Suite

Three layers of checks run on every PR that touches `**/*.tf`:

| Tool | What it catches | Speed |
|---|---|---|
| `terraform fmt` + `validate` | Syntax errors, schema mistakes | <5s |
| **tflint** | Provider-specific anti-patterns (e.g. missing tags, deprecated args, EC2 instance type typos) | ~10s |
| **Checkov** | Policy & security misconfigs — public S3, missing encryption, overly-broad IAM, no logging, etc. SARIF results uploaded to GitHub Security tab. | ~30s |
| **Terratest** (optional) | Real `terraform apply` against ephemeral cloud resources, assertions on actual outputs | 5–60 min |

## Configuration

- **tflint rules**: edit `.tflint.hcl` at repo root
- **Checkov skips**: add `# checkov:skip=CKV_AWS_18: justification here` inline
- **Terratest**: tests live in `tests/terratest/`. Each test must call `defer terraform.Destroy(...)` first so resources are cleaned even on failure.

## When does each run?

`fmt-and-validate`, `tflint`, `checkov` run on every PR. Fast and free.

`terratest` only runs when enabled in the scaffold form. It costs real cloud spend and uses OIDC creds from `vars.AWS_OIDC_ROLE_ARN`. Set that variable in repo settings before enabling.

## Why this matters

Catches Terraform misconfigs at PR time instead of at apply time in prod. Same shift-left principle as the language CI gates — feedback in 30 seconds, not 30 minutes.
