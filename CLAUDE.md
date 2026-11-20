# CLAUDE.md

A GitHub template for an Internal Developer Platform: Backstage + ArgoCD + KAgent/MCP on Kind or Rancher Desktop locally, EKS on AWS.

Where to look instead of here:
- Script flags: `docs/scripts-reference.md`, or `./scripts/<name>.sh --help`
- CLI: `docs/cli-reference.md`
- Local setup and URLs: `docs/local-setup.md`, `local/hosts-append.txt`
- AWS: `docs/PRE_DEPLOYMENT_CHECKLIST.md`, `docs/DEPLOYMENT_GUIDE.md`
- Architecture: `docs/architecture.md`, `docs/design/adr-*.md`
- Component map and per-component CI gates: `.claude/context/platform-map.md`

Entry points: `./scripts/setup.sh` (first time), `./scripts/bootstrap-local.sh` (day 2), `./scripts/bootstrap.sh --profile medium` (AWS), `./scripts/bootstrap-ai.sh` (AI stack).

## Done means

The CI gate passes for every component you touched, and you quote its real output. The gates are listed in `.claude/context/platform-map.md` §2 and `.claude/skills/platform-engineer/SKILL.md`:
- Go (`cli/`, `services/hello-service/`): `go build ./... && go vet ./... && go test ./...`. These are separate modules, so run each one from its own directory.
- `helm/service-template`: `helm lint`, both plain and with `--set image.repository=test --set image.tag=abc1234`.
- `kubernetes/`: kubeconform.
- `terraform/`: `terraform fmt -check -recursive && terraform init -backend=false && terraform validate`.
- `backstage/app/`: `yarn lint`, `yarn test --testPathPattern=<name>`, `yarn build:backend`. `build:backend` is esbuild in transpile-only mode, so it passes with type errors; run `tsc` as well if types matter.
- Templates: `python3 scripts/validate-catalog-templates.py`. MCP tool names: `python3 scripts/validate-mcp-tool-names.py`.

Hooks in `.claude/settings.json` run the fast per-file lint after each edit, and `go test` before a stop. When one exits 2, fix the failure; don't work around it.

Cloud sessions have no cluster, no Docker and no `local/.env`, so keep cloud work to code plus CI gates. A coordinating session can split work across worktrees or cloud sessions. Before accepting a result, check it against this section and run the `platform-reviewer` skill. Send back anything that doesn't pass.

## Rules the code doesn't tell you

### Layout
- `bootstrap-local.sh` reads only `local/` + `kubernetes/`. `bootstrap.sh` reads only `aws/` + `kubernetes/`. No cross-reads. `kubernetes/` holds only what both share.
- Backstage config comes in three layers. `backstage/app-config.yaml` is the env-agnostic base. `app-config.local.yaml` holds the Docker Compose overrides. `app-config.aws.yaml` holds the EKS overrides, mirrored into `kubernetes/backstage/configmap.yaml` (`backstage-config`).
- `helm/service-template/` is the only workload abstraction. Services only add `helm-values-local.yaml` / `helm-values-aws.yaml`; never write raw Deployment YAML.
- Terraform owns the foundation: VPC, EKS, IAM, and the Crossplane IRSA role. Crossplane owns per-service AWS resources requested via templates (`services/<svc>/claims/`). See `docs/crossplane-vs-terraform.md`.

### Backstage backend
- Custom scaffolder actions must import `scaffolderActionsExtensionPoint` from `@backstage/plugin-scaffolder-node`, not `/alpha`. The alpha path crashes the scaffolder plugin at startup. That stalls the catalog refresh loop, and the catalog shows up empty. If `refresh_state` has rows but `final_entities` is 0, check this first.
- The JSON-schema type errors in the action modules are pre-existing and harmless, because esbuild ignores them.
- Learning-center (`idpLearningCenter.ts`) resolves the caller via `httpAuth.credentials(req, { allow: ['user'] })`. Don't switch it to a client header: the browser calls it directly, so a header could be forged. The AI Assistant's `X-Backstage-User` forwarding is safe only because KAgent sits in between.
- Frontend plugins use `createFrontendPlugin({ pluginId })`. The old `id` field is a TS error.
- `@material-table/core` 3.x breaks with uuid 10. A committed yarn patch (`.yarn/patches/@material-table-core-npm-3.2.5-*.patch`) fixes it. After `yarn install`, `grep "uuid.*v4" backstage/app/node_modules/@material-table/core/dist/utils/data-manager.js` should show `(_uuid["default"] || _uuid).v4()`.
- `versions:bump` crashes in this repo. Upgrade Backstage via the release manifest instead.

### Adding a proxy target
Use the same path key in local and AWS (e.g. `/prometheus`, not `/prometheus/api`), and add `pathRewrite: '^/api/proxy/<name>': ''`. A mismatch doubles path segments (`/api/api/v1/query`), which gives silent 404s in production only. Touch all four places:
1. `app-config.aws.yaml` + the configmap mirror
2. `app-config.local.yaml`
3. `extra_hosts` in `local/backstage/docker-compose.yml`
4. `local/hosts-append.txt`

### Software templates
- Every `${{ parameters.X }}` used in a step needs an `X:` declaration. If one is missing, the scaffold crashes only when that conditional step is reached.
- Register a new template in both front doors: a `file:` entry in `backstage/app-config.yaml`, and a `url:` entry in `app-config.aws.yaml` + `kubernetes/backstage/configmap.yaml`. Mobile templates go in `backstage/catalog/mobile-catalog.yaml` instead.
- Templates are bind-mounted locally, so a `restart backstage` is enough. Rebuild only for changes under `backstage/app/packages/`.
- For a new test-suite template, add it to `templateRef` in `cli/cmd/idp/testsuite.go`. If it opens a PR on an existing repo instead of creating `test-suites/<name>/`, also add it to `apiOnlyTypes` in `cli/internal/scaffold/local_testsuite.go`.

### GitOps and the AI stack
- These five services are excluded from the `idp-services` ApplicationSet in both `local/argocd/app-of-apps-local.yaml` and `aws/argocd/app-of-apps.yaml`: `contract-mcp-server`, `agent-event-router`, `github-mcp-server`, `argocd-mcp-server` and `cost-mcp-server`. `bootstrap-ai.sh` builds their images and creates their secrets from `local/.env`. Don't remove the exclusions without updating that script.
- One agentgateway (`kubernetes/ml-platform/ai-gateway.yaml`, ADR-0007) fronts all MCP servers and model traffic. Model calls go through LiteLLM (ADR-0008); `--skip-litellm` leaves agents with tools but no model replies.
- Gateway `prefixMode: never` means tool names aren't namespaced. A tool in an agent's `toolNames` must exist on exactly one target, or the UI silently shows "No description available". `scripts/validate-mcp-tool-names.py` guards this.
- A Ready agent can still be missing tools when a target is down (`failureMode: failOpen`). Check `kubectl logs -n ml-platform deploy/ai-gateway`.

### Destroy and cleanup
- `_cleanup_scaffolded_services` (`scripts/lib.sh`) finds scaffolded services by `helm-values-local.yaml` / `helm-values-aws.yaml`. Don't switch it to a Dockerfile check: scaffolded services keep their Dockerfile in their own repo, so that check silently matches nothing.
- The cleanup never touches `hello-service` or the built-in MCP servers. It intentionally leaves `kubernetes/teams/`, `test-suites/` and external GitHub repos alone.
- If a new template writes into the platform repo outside `services/`, extend `_cleanup_scaffolded_services` to scan that directory too.

### Local quirks
- Catalog files are bind-mounted from `backstage/catalog/`. At container start, `moatazeldebsy` placeholders are replaced with `$GITHUB_ORG`.
- `K8S_*`, `ARGOCD_AUTH_TOKEN` and `GRAFANA_TOKEN` in `local/backstage/.env` are written by the bootstrap scripts. Don't set them by hand.
- After a Docker Desktop restart, run `./scripts/recover-docker-restart.sh`.
- Rancher Desktop needs Traefik off, dockerd as the engine, and `KUBERNETES_PROVIDER=rancher-desktop` in `local/.env`.
