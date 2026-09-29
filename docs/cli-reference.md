# IDP CLI Reference

The `idp` CLI is the terminal companion to the Backstage portal. It scaffolds services and test suites using the Backstage Scaffolder API when the platform is reachable, and falls back to local file generation when offline. `idp template run` reaches every other software template in the catalog.

## Greenfield vs brownfield

| You have… | Use | Result |
|---|---|---|
| Nothing yet — a new service | `idp scaffold service --type <lang>` | New GitHub repo from the golden path |
| A new standalone test repo | `idp scaffold test-suite --type <type>` | New GitHub repo named `--name` |
| An existing service repo that needs tests | `idp scaffold test-suite --type <type> --target-repo owner/repo` | PR against that repo |
| An existing repo that needs SAST/SCA | `idp scaffold test-suite --type security --target-repo owner/repo` | PR adding SonarCloud + Snyk |
| Anything else (S3, RDS, namespace, secret, SLO, decommission, `enable-*` add-ons…) | `idp template run <template> --set k=v` | Whatever the template does |

`unit`, `component`, `iac`, `flutter-integration` and `security` are brownfield-only and require `--target-repo`.

## Installation

```bash
# Build binary to ./bin/idp
make cli-build

# Or install to $(GOPATH)/bin
make cli-install
```

## Shell completion

Cobra generates completion scripts for bash, zsh, fish, and PowerShell:

```bash
# Bash (add to ~/.bashrc or /etc/bash_completion.d/)
idp completion bash > /usr/local/etc/bash_completion.d/idp

# Zsh (add to ~/.zshrc)
source <(idp completion zsh)

# Fish
idp completion fish | source
```

## Commands

### `idp scaffold service`

Scaffold a new service (greenfield). Uses the Backstage Scaffolder API when reachable; falls back to generating files locally under `services/<name>/`. Only `nodejs`, `python` and `go` have a local generator — `jvm`, `ruby` and `react` need Backstage.

**Flags:**

| Flag | Default | Description |
|------|---------|-------------|
| `--name` | *(required)* | Service name — lowercase alphanumeric + hyphens |
| `--type` | `nodejs` | `nodejs` \| `python` \| `go` \| `jvm` \| `ruby` \| `react` (→ `react-frontend` template) |
| `--namespace` | `services-dev` | Kubernetes namespace (local generation only) |
| `--env` | `local` | `local` \| `aws` — sent to the template as `deployTarget` |
| `--cluster-name` | `idp-mvp` | EKS cluster name (`--env aws` only) |
| `--aws-region` | `AWS_REGION` or `us-east-1` | AWS region (`--env aws` only) |
| `--cost-center` | `eng-platform` | `cost-center` pod label (required by `require-cost-tags`) |
| `--local` | `false` | Skip Backstage API, generate files locally |
| `--dry-run` | `false` | Print files that would be generated without writing them |
| `--backstage-url` | `http://backstage.idp.local` | Backstage base URL |
| `--owner` | `group:default/platform-team` | Backstage catalog owner ref |
| `--description` | | Short description (used by Backstage template) |

**Examples:**

```bash
# Node.js service (auto-detects Backstage)
idp scaffold service --name order-svc --type nodejs

# Python FastAPI service, force local generation
idp scaffold service --name data-pipeline --type python --local

# Go service
idp scaffold service --name inventory-svc --type go

# Spring Boot service on EKS
idp scaffold service --name ledger-svc --type jvm --env aws

# Preview what would be generated without writing anything
idp scaffold service --name billing-svc --type nodejs --dry-run
```

**Generated files (all types):**

```
services/<name>/
├── src/                    # Application code + tests
├── Dockerfile
├── README.md
├── mkdocs.yml + docs/      # TechDocs
├── helm-values-local.yaml  # Kind / nginx — localhost:5003 image, cost labels
├── helm-values-aws.yaml    # EKS dev — CI rewrites image repo/tag
├── catalog-info.yaml       # register via /catalog-import (printed after scaffolding)
├── package-lock.json       # nodejs, generated with npm if on PATH
└── requirements-dev.txt    # python — pytest + pytest-cov for build-and-deploy.yml
```

There is no per-service CI workflow: the service lives in the platform repo,
where GitHub only runs root-level workflows. `build-and-deploy.yml` is its CI.
For every changed `services/*` directory it runs the same quality bar the
Backstage `go`/`nodejs`/`python-service` templates put in a new repo's own CI —
static analysis (`go vet` + golangci-lint / `tsc` or `node --check` / ruff),
a dependency vulnerability scan (govulncheck / `npm audit` / pip-audit), a 70%
coverage gate, a Trivy filesystem scan, and a container smoke test against
`/healthz` — then builds, scans, and deploys the image. Generated
services pass it as-is. A service below 70% records its current floor in a
`.coverage-min` file (one number); raise it as tests are added, never lower it.
`helm-values-staging.yaml` is created by that workflow on first
promotion. `--owner` and `--cost-center` fill the `team` / `cost-center` pod
labels the `require-cost-tags` Gatekeeper policy enforces in `services-*`.

---

### `idp scaffold test-suite`

Scaffold a QA/testing suite. Supports 20 test types. By default the suite goes into a new repo; `--target-repo` opens a PR against an existing one instead.

**Common flags:**

| Flag | Default | Description |
|------|---------|-------------|
| `--name` | *(required)* | Suite name — lowercase alphanumeric + hyphens |
| `--type` | *(required)* | Test suite type (see table below) |
| `--service` | *(required)* | Target service name |
| `--namespace` | `services` | Kubernetes namespace of the target service |
| `--local` | `false` | Skip Backstage API, generate files locally |
| `--dry-run` | `false` | Print files that would be generated without writing them |
| `--backstage-url` | `http://backstage.idp.local` | Backstage base URL |
| `--owner` | `group:default/platform-team` | Backstage catalog owner ref |
| `--description` | | Short description |
| `--target-repo` | | Existing repo (`owner/repo` or GitHub URL) to open a PR against — brownfield mode |
| `--target-url` | | URL of the running service under test (sent as `targetUrl` / `baseUrl` / `providerBaseUrl`) |
| `--set` | | Any other template parameter as `key=value` (repeatable) — see `idp template params` |

Type-specific flags are forwarded to Backstage only when you set them; otherwise the template's own defaults apply. With `--dry-run`, Backstage-only types print the values that would be sent, checked against the template in your checkout.

**Supported types:**

| Type | Description | Key flags |
|------|-------------|-----------|
| `playwright` | E2E browser tests | `--cloud-grid` (none\|lambdatest\|browserstack\|sauce-labs) |
| `k6` | Load / performance tests | `--vus` (10), `--duration` (30s), `--p95` (500) |
| `pact` | Consumer contract tests | `--consumer`, `--provider`, `--broker-url` |
| `newman` | Postman / API tests | — |
| `zap` | OWASP DAST security scan | `--scan-type` (baseline\|full\|api\|graphql), `--openapi-url`, `--fail-risk` |
| `datadog` | Datadog synthetic monitors | `--dd-site` (datadoghq.eu) |
| `visual` | Screenshot regression | `--threshold` (0.2), `--cloud-grid` (none\|lambdatest\|browserstack\|sauce-labs) |
| `accessibility` | WCAG a11y audit | `--wcag` (wcag2a\|wcag2aa\|wcag21aa\|wcag22aa) |
| `cucumber` | BDD Gherkin scenarios | — |
| `appium` | Mobile UI tests | `--platform` (android\|ios), `--appium-server`, `--device-farm` (local-emulator\|browserstack\|sauce-labs\|lambdatest) |
| `chaos` | Chaos Mesh experiments | `--experiments`, `--chaos-duration` (1m) |
| `mutation` | Stryker mutation testing | `--score` (70), `--test-runner` (jest\|mocha\|jasmine) |
| `testcontainers` | Integration tests with containers | `--containers` (postgres) |
| `unit` | Unit-test scaffold (Go / Node / Python) with coverage gate | **Requires `--target-repo`**; `--language` (go\|nodejs\|python), `--coverage` (70) |
| `component` | Service-as-black-box tests with WireMock-stubbed deps | **Requires `--target-repo`** |
| `iac` | Terraform IaC checks (tflint + Checkov + optional Terratest) | **Requires `--target-repo`** |
| `flutter-integration` | Flutter integration test suite | **Requires `--target-repo`** |
| `security` | SAST/SCA — SonarCloud + Snyk (`enable-security-scanning`) | **Requires `--target-repo`** |
| `deepeval` | LLM output evaluation (DeepEval) | Backstage only; `--agent-prompt`, `--agent-tools` (required), `--target-agent` |
| `contract` | MCP-driven contract testing (`enable-contract-testing`) — preferred over `pact` | Backstage only; `--consumer`, `--provider`, `--namespace` |

**Examples:**

```bash
# Playwright E2E suite
idp scaffold test-suite --name hello-e2e --type playwright --service hello-service

# k6 load test — 50 VUs, 5 min, p95 < 300 ms
idp scaffold test-suite --name hello-load --type k6 --service hello-service \
  --vus 50 --duration 5m --p95 300

# OWASP ZAP DAST security scan
idp scaffold test-suite --name hello-sec --type zap --service hello-service \
  --scan-type baseline

# WCAG 2.1 AA accessibility audit
idp scaffold test-suite --name hello-a11y --type accessibility --service hello-service \
  --wcag wcag21aa

# Pact consumer contract tests
idp scaffold test-suite --name hello-contracts --type pact --service hello-service \
  --consumer frontend --provider hello-service

# Chaos resilience experiments
idp scaffold test-suite --name hello-chaos --type chaos --service hello-service \
  --chaos-duration 2m

# Stryker mutation testing, 80% threshold
idp scaffold test-suite --name hello-mutation --type mutation --service hello-service \
  --score 80

# Brownfield: add Playwright tests to an existing repo (opens a PR)
idp scaffold test-suite --name hello-e2e --type playwright --service hello-service \
  --target-repo my-org/hello-service

# Brownfield-only: unit tests with an 80% coverage gate
idp scaffold test-suite --name hello-unit --type unit --service hello-service \
  --target-repo my-org/hello-service --language go --coverage 80

# SonarCloud + Snyk on an existing repo
idp scaffold test-suite --name hello-scan --type security --service hello-service \
  --target-repo my-org/hello-service

# Preview what would be generated
idp scaffold test-suite --name hello-e2e --type playwright --service hello-service --dry-run

# Force local generation (offline)
idp scaffold test-suite --name hello-e2e --type playwright --service hello-service --local
```

**Generated directory structure (greenfield types with a local generator):**

```
test-suites/<name>/
├── tests/              # Test files (type-specific)
├── README.md
├── catalog-info.yaml   # Backstage test-suite registration
├── mkdocs.yml          # TechDocs
└── docs/
    └── index.md
```

---

### `idp template`

Generic access to every software template in the catalog — infrastructure (S3, RDS, Kafka, DynamoDB, SQS; Terraform and Crossplane variants), namespaces, secrets, SLOs, canary rollouts, decommissioning, AI agents, MCP servers, and the `enable-*` brownfield add-ons. Requires Backstage.

| Command | Purpose |
|---------|---------|
| `idp template list [--tag <tag>]` | List registered templates (name, type, title, tags) |
| `idp template params <template>` | Show each parameter's type, whether it's required, allowed values and default |
| `idp template run <template> [--set k=v]… [--values file.yaml] [--dry-run]` | Run the template and stream the scaffolder log |

`run` converts `--set` strings to the types the template declares (integer, number, boolean, comma-separated or JSON array), drops keys the template doesn't declare, and reports missing required parameters — including conditional ones such as `targetRepoUrl` — before a task is created. `--set` wins over `--values`. `--dry-run` validates against the live template and prints the values without creating a task.

```bash
idp template list --tag crossplane
idp template params s3-bucket-crossplane
idp template run s3-bucket-crossplane --set name=orders-archive --set owner=group:default/payments

# Brownfield add-on to an existing repo
idp template run enable-datadog-apm --values apm.yaml --dry-run
```

---

### Day-2 commands

| Command | Purpose | Flags |
|---------|---------|-------|
| `idp deploy --service <name>` | `helm upgrade --install` with `helm/service-template` and the service's `helm-values-<env>.yaml` | `--namespace` (services), `--env` (local\|aws), `--dry-run` |
| `idp status --service <name>` | Deployment/pod status, plus ArgoCD sync status if available | `--namespace` (services) |
| `idp logs --service <name>` | Tail the deployment's logs | `--namespace` (services), `-f/--follow`, `--tail` (100) |
| `idp runner setup --repo <name>` | Register and start a GitHub Actions self-hosted runner (wraps `scripts/setup-runner.sh`) | `--repo` |
| `idp ai "<message>"` | Ask the `idp-assistant` KAgent agent in natural language | `--env`, `--kagent-url`, `--timeout` (300), `--backstage-url` |

---

### `idp completion`

Generate shell completion scripts (auto-provided by Cobra):

```bash
idp completion bash
idp completion zsh
idp completion fish
idp completion powershell
```

---

### `idp version` / `idp --version`

Print the CLI version. Binaries built with `make cli-build` embed the git tag/sha automatically (e.g. `v0.1.0-42-gabcdef`).

---

### Developer experience (DX) commands

| Command | Purpose |
|---------|---------|
| `idp doctor` | Check local tool versions + cluster health. Flags: `--tools-only`, `--project-only`, `--fix` |
| `idp context inject --service <name>` | Write live catalog annotations into `CLAUDE.md` (or `--target cursor`). `--dry-run` to preview |
| `idp learn --type component --name <name>` | Curated TechDocs / SLO / Scorecard next steps for a catalog entity |
| `idp tip` | Print a platform onboarding tip |
| `idp mcp status` | Check reachability of the AI Gateway, LiteLLM, and all platform MCP servers (ADP servers need `bootstrap-ai.sh --adp`) |

---

## Configuration

### Token resolution order

When calling the Backstage Scaffolder API, the CLI resolves the auth token in this priority order:

1. `--token` flag (on `idp scaffold` and `idp template`)
2. `BACKSTAGE_TOKEN` environment variable
3. First static `externalAccess` token in `backstage/app-config.local.yaml`

`BACKSTAGE_AUTH_SECRET` in `local/backstage/.env` is never used: it is the backend's service-token signing key, not a bearer token, and Backstage rejects it with `401 Illegal token`.

### Environment variables

| Variable | Purpose |
|----------|---------|
| `BACKSTAGE_TOKEN` | Bearer token for Backstage API calls |
| `GITHUB_ORG` or `GH_ORG` | GitHub org used in generated catalog entries |
| `PLATFORM_REPO` | Platform repo name (default: `backstage-platform-template`) |

---

## Offline / local mode

Pass `--local` to skip the Backstage health check entirely and generate files directly on disk. Useful before the platform is running or in CI pipelines that don't have Backstage access.

Pass `--dry-run` to see exactly which files would be written without touching the filesystem — no Backstage call, no git commit.
