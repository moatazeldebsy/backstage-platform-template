# Platform Map

Shared reference for the persona skills in `.claude/skills/`. Everything here is
cross-cutting: facts that more than one role needs and that are easy to get wrong
from memory. Role-specific checklists live in each `SKILL.md`.

Verified against `.github/workflows/ci.yml` and `docs/crossplane-vs-terraform.md`.
When CI changes, update the gate table here rather than in seven places.

---

## 1. Layer ownership — where does a change belong?

Four systems provision things. They do not overlap by design; putting a resource in
the wrong one is the most expensive mistake available in this repo.

| Layer | Path | Owns | Applied by |
|---|---|---|---|
| **Terraform** | `terraform/` | Account/cluster foundation: VPC, EKS, ECR, IAM/IRSA/OIDC, MSK cluster, RDS-for-Backstage, S3 state, Secrets Manager | `scripts/bootstrap.sh`, once per environment |
| **Crossplane** | `aws/crossplane/` | Per-service AWS resources requested by app teams as Claims: S3 buckets, RDS instances, MSK topics, DynamoDB tables, SQS queues | ArgoCD, reconciling Claims committed to Git |
| **Helm** | `helm/service-template/` | Every service's runtime workload — Deployment, Service, Ingress, HPA, PDB, ServiceAccount, ServiceMonitor, Rollout | ArgoCD (or `idp deploy` locally) |
| **Kubernetes manifests** | `kubernetes/` | Cluster-scoped platform config: namespaces, RBAC, network policies, Kyverno policies, ArgoCD Applications (app-of-apps), team scaffolds | ArgoCD; some by `bootstrap-*.sh` |

**Decision rule** (from `docs/crossplane-vs-terraform.md#decision-matrix`):

- Must exist *before* the EKS cluster runs → **Terraform**
- Cluster-scoped, one per environment, platform-team lifecycle → **Terraform**
- Requested per-service by an app team via Backstage, self-serve, drift auto-corrected → **Crossplane**

Note the deliberate splits: MSK **cluster** is Terraform but MSK **topics** are
Crossplane; RDS **for Backstage** is Terraform but **per-service** RDS is Crossplane;
the Crossplane IRSA role itself is Terraform (chicken-and-egg). Full allocation table
and the "same resource, different tool" pitfall: `docs/crossplane-vs-terraform.md`.

---

## 2. CI gates — the exact commands

`.github/workflows/ci.yml` has a `changes` job that diffs the PR and gates every
other job behind an `if:`. **The workflow deliberately has no `paths:` filter on the
`pull_request` trigger** — a required check that never starts is pending forever, so
the workflow always starts and jobs skip themselves instead. Don't "optimize" that
back into a trigger-level path filter.

Run the gate for every component you touched, from the repo root, before saying done:

| Touched | Job | Command |
|---|---|---|
| `backstage/catalog/**` | `catalog-lint` | `python3 scripts/validate-catalog-templates.py` (needs PyYAML) |
| `scripts/*.sh` | `shell-lint` | `bash -n <each>` then `shellcheck --severity=error --exclude=SC1091 <each>` |
| anything | `secrets-scan` | gitleaks over full history |
| `services/hello-service/**` | `test-hello-service` | `cd services/hello-service && go test ./... -coverprofile=coverage.out -covermode=atomic` |
| `cli/**` | `test-cli` | `cd cli && go build ./... && go vet ./... && go test ./...` |
| `observability/`, `local/observability/`, `aws/observability/` | `python-observability-checks` | `python -m py_compile` on the 4 exporters |
| `helm/**` | `helm-lint` | `helm lint helm/service-template` **and** `helm lint helm/service-template --set image.repository=test --set image.tag=abc1234` |
| `kubernetes/**` | `k8s-dry-run` | `kubeconform -strict -summary kubernetes/namespaces/` and `.../rbac/`; `kubernetes/monitoring/` and `kubernetes/kagent/` additionally need `-schema-location default -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'` (kagent also `-ignore-missing-schemas -ignore-filename-pattern 'values-.*\.yaml'`) |
| `backstage/app/**`, `app-config*.yaml`, `backstage/Dockerfile` | `backstage-compile` | `cd backstage/app && yarn install --immutable && yarn build:backend`, then `docker build -t backstage:ci -f backstage/Dockerfile backstage/app` |
| `services/contract-mcp-server/**` | `contract-mcp-server-build` | `cd services/contract-mcp-server && npm ci && npm run build` |
| any other MCP server, `agent-event-router`, `approval-service` | `mcp-servers-build` | `cd services/<svc> && npm ci && npm run build && npm test` (matrix over 9 services, plus an ESM-resolution import of the built entrypoint) |
| `kubernetes/kagent/*.yaml` | `backstage-compile` (via the `kagent` filter) | `kagentGeneratedCrs.test.ts` — the Agent CRs two scaffolder actions build as template strings must only reference RemoteMCPServers, ModelConfigs and tool names that exist. Editing kagent manifests triggers the Backstage suite for exactly this reason. |
| any `src/telemetry.ts`, or `services/mcp-common/` | `mcp-telemetry-drift` | every server's copy must match `services/mcp-common/src/` — `./scripts/sync-mcp-common.sh --check`. Edit the mcp-common copy, then run the script without `--check` to push it out. |
| MCP metric declarations, AI dashboards, alert rules, EI Prometheus client | `mcp-metrics-contract` | `python3 scripts/validate-mcp-metrics.py` |
| `terraform/**` | `terraform-check` | `cd terraform && terraform fmt -check -recursive && terraform init -backend=false && terraform validate` |

### Coverage worth knowing

All ten Node services are covered: `contract-mcp-server` by its own job, the other
seven MCP servers plus `agent-event-router` and `approval-service` by the
`mcp-servers-build` matrix. Three cross-cutting contracts have their own gates —
`telemetry.ts` matching its `services/mcp-common/` source, the
`mcp_tool_calls_total` label set, and the
ESM-resolution import — because each failed silently at least once before the gate
existed. Still run the component's own `npm run build && npm test` locally; the
matrix is the backstop, not the fast feedback loop.

### The other seven workflows

| Workflow | Fires on | Guards |
|---|---|---|
| `codeql.yml` | push/PR to `backstage/app/`, `cli/`, `services/`; weekly Monday 06:00 | SAST across JS/TS + Go |
| `build-and-deploy.yml` | push/PR touching `services/**` | Per-service image build → ECR → EKS deploy (cluster/region from `.idp-config.env`) |
| `contract-check.yml` | PR touching `openapi.*`, `api/**`, `src/**` | Validates a service's OpenAPI spec against the contract registry; posts a PR comment |
| `scaffold.yml` | push to `main` touching `kubernetes/teams/**`, `backstage/catalog/groups/**` | Applies scaffolder-generated namespaces/RBAC/ArgoCD projects to the cluster |
| `eval.yml` | push/PR touching `test-suites/test-deepeval/**`, `kubernetes/kagent/idp-agent.yaml` | DeepEval LLM quality gate on the KAgent agent |
| `docs.yml` | push to `main` touching `docs/**`, `mkdocs.yml` | Publishes MkDocs to GitHub Pages |
| `onboarding-auto-merge.yml` | any PR titled `feat: onboard ` | Auto-approves **only** if every changed file matches `^services/[^/]+/helm-values[^/]*\.yaml$`; fails otherwise |

---

## 3. The dual-target rule

Every service — hand-written or scaffolded — deploys through the single
`helm/service-template` chart, parameterized per target:

| | Local (Kind) | AWS (EKS) |
|---|---|---|
| Values file | `helm-values-local.yaml` | `helm-values-aws.yaml` |
| Ingress | nginx | ALB via AWS Load Balancer Controller |
| Registry | `localhost:5003` | ECR |
| Overlay dir | `local/` | `aws/` |

Reference implementation: `services/hello-service/` (has both values files, plus
`claims/` for its Crossplane resources).

**A chart change is unverified until you have checked it against both values files.**
A template that renders fine under local values can break the AWS path (and vice
versa) — different ingress class, different annotations, different image repo shape.

---

## 4. The config-layer rule

Backstage config is merged at startup from:

`backstage/app-config.yaml` (base) + `app-config.local.yaml` (Kind) +
`app-config.aws.yaml` (EKS) + `app-config.production.yaml`

New config picks a layer deliberately. Target-specific values (URLs, ingress hosts,
cluster names, auth providers) belong in the overlay, not the base. Only put it in
the base file if it's true everywhere.

---

## 5. Scaffolding has two front doors

A template must be registered in **both** places or it silently won't appear:

1. `backstage/app-config.yaml` under `catalog.locations`
2. `backstage/catalog/all-templates.yaml`

And there are **two implementations of generation logic** that can drift:

- Backstage skeletons: `backstage/catalog/templates/<name>/skeleton/`
- CLI local fallback: `cli/internal/scaffold/local.go`, `local_testsuite.go`, `templates/`

The CLI scaffolds against the Backstage API when reachable and falls back to local
generation otherwise. Change one, check whether the other needs the matching change.

---

## 6. Standing constraints — do not "fix" these

- **react-router v6 pin.** `backstage/app` holds `react-router-dom@^6.x` transitively
  via `@backstage/frontend-defaults` / `@backstage/core-app-api`, with open Dependabot
  advisories. Bumping it independently breaks the frontend. This is a tracked accepted
  risk with a re-evaluation condition in `SECURITY.md` — treat it as *known*, not as a
  finding.
- **`setup.sh` is one-time.** It personalizes placeholders and writes `.idp-config.env`.
  Every day-2 operation belongs to `bootstrap-local.sh` (Kind) / `bootstrap.sh` (AWS) /
  `bootstrap-multiregion.sh`. Never suggest re-running `setup.sh` to fix a cluster.
  Rationale: `docs/scripts-reference.md#setupsh-vs-bootstrap-localsh-why-two-scripts`.
- **`.idp-config.env` is generated**, not hand-edited. It's the single source of truth
  for org, cluster name, AWS account/region, contact email.
- **Manifests in `kubernetes/` are reconciled by ArgoCD**, not applied by hand. A
  scaffolded service's `catalog-info.yaml` + Helm values are what drive its deployment.
- **Opt-in layers that are live on `main`** — check before assuming they're inactive:
  multi-region V2 (`scripts/bootstrap-multiregion.sh`, active-standby `eu-central-1`
  primary + `us-east-1` standby) and the Agentic Development Platform
  (`scripts/bootstrap-ai.sh --adp`).

---

## 7. Component quick-reference

| Component | Language | Dir | Build / test |
|---|---|---|---|
| Backstage app | TS, Yarn 4 workspaces | `backstage/app/` | `yarn start`, `yarn lint`, `yarn test`, `yarn build:backend`, `tsc` |
| `idp` CLI | Go | `cli/` | `go build ./... && go vet ./... && go test ./...`, or `make cli-build` |
| `hello-service` | Go | `services/hello-service/` | `go test ./...` |
| MCP servers ×8 | TS, Jest | `services/*-mcp-server/` | `npm run build && npm test` |
| Golden-path chart | Helm | `helm/service-template/` | `helm lint` (see gate table) |
| Infra | Terraform | `terraform/` | `fmt -check -recursive`, `init -backend=false`, `validate` |
| Scaffolder templates ×61 | YAML + skeletons | `backstage/catalog/templates/` | `python3 scripts/validate-catalog-templates.py` |

Deep-dive docs: `docs/architecture.md`, `docs/golden-path.md`, `docs/cli-reference.md`,
`docs/scripts-reference.md`, `docs/multi-region.md`, `docs/agentic-platform.md`,
`docs/crossplane-vs-terraform.md`.
