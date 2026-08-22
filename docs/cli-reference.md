# IDP CLI Reference

The `idp` CLI is the terminal companion to the Backstage portal. It scaffolds services and test suites using the Backstage Scaffolder API when the platform is reachable, and falls back to local file generation when offline.

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

Scaffold a new microservice. Uses the Backstage Scaffolder API when reachable; falls back to generating files locally under `services/<name>/`.

**Flags:**

| Flag | Default | Description |
|------|---------|-------------|
| `--name` | *(required)* | Service name — lowercase alphanumeric + hyphens |
| `--type` | `nodejs` | `nodejs` \| `python` \| `go` |
| `--namespace` | `services` | Kubernetes namespace |
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

# Preview what would be generated without writing anything
idp scaffold service --name billing-svc --type nodejs --dry-run
```

**Generated files (all types):**

```
services/<name>/
├── src/                    # Application code
├── Dockerfile
├── README.md
├── helm-values.yaml        # AWS / ALB overrides
├── helm-values-local.yaml  # Kind / nginx overrides
├── helm-values-aws.yaml
├── helm-values-staging.yaml
├── catalog-info.yaml       # Backstage registration
└── .github/
    └── workflows/
        └── ci.yml
```

---

### `idp scaffold test-suite`

Scaffold a QA/testing suite. Supports 18 test types.

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

**Supported types:**

| Type | Description | Key flags |
|------|-------------|-----------|
| `playwright` | E2E browser tests | — |
| `k6` | Load / performance tests | `--vus` (10), `--duration` (30s), `--p95` (500) |
| `pact` | Consumer contract tests | `--consumer`, `--provider`, `--broker-url` |
| `newman` | Postman / API tests | — |
| `zap` | OWASP DAST security scan | `--scan-type` (baseline\|full\|api\|graphql), `--openapi-url`, `--fail-risk` |
| `datadog` | Datadog synthetic monitors | `--dd-site` (datadoghq.eu) |
| `visual` | Screenshot regression | `--threshold` (0.2) |
| `accessibility` | WCAG a11y audit | `--wcag` (wcag2a\|wcag2aa\|wcag21aa\|wcag22aa) |
| `cucumber` | BDD Gherkin scenarios | — |
| `appium` | Mobile UI tests | `--platform` (android\|ios), `--appium-server`, `--device-farm` (local-emulator\|browserstack\|sauce-labs\|lambdatest) |
| `chaos` | Chaos Mesh experiments | `--experiments`, `--chaos-duration` (1m) |
| `mutation` | Stryker mutation testing | `--score` (70), `--test-runner` (jest\|mocha\|jasmine) |
| `testcontainers` | Integration tests with containers | `--containers` (postgres) |
| `unit` | Brownfield unit-test scaffold (Go / Node / Python) with coverage gate | Backstage API only |
| `component` | Service-as-black-box tests with WireMock-stubbed deps | Backstage API only |
| `iac` | Terraform IaC checks (tflint + Checkov + optional Terratest) | Backstage API only |
| `flutter-integration` | Flutter integration test suite | Backstage API only |
| `deepeval` | LLM output evaluation (DeepEval) | Backstage API only |

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

# Preview what would be generated
idp scaffold test-suite --name hello-e2e --type playwright --service hello-service --dry-run

# Force local generation (offline)
idp scaffold test-suite --name hello-e2e --type playwright --service hello-service --local
```

**Generated directory structure (all types):**

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
| `idp mcp status` | Check reachability of all platform MCP servers |

---

## Configuration

### Token resolution order

When calling the Backstage Scaffolder API, the CLI resolves the auth token in this priority order:

1. `--token` flag (explicit override on the `scaffold` parent command)
2. `BACKSTAGE_TOKEN` environment variable
3. `BACKSTAGE_AUTH_SECRET` in `local/backstage/.env`
4. First static `externalAccess` token in `backstage/app-config.local.yaml`

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
