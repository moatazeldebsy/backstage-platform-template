# Local Setup (Kind)

Run the full IDP platform on your laptop — no AWS account required.

## Prerequisites

```bash
# macOS
brew install kind kubectl helm docker

# Verify
kind version    # >= 0.27
kubectl version --client
helm version    # >= 3.14
docker info     # Docker running
```

> **macOS ARM64 note**: The cluster is pinned to K8s **1.33.1** (`kindest/node:v1.33.1`) — tested stable on macOS ARM64 with Docker Desktop.

## Bootstrap (~10–15 min)

> **First time?** Run `./scripts/setup.sh` from the repo root — it handles placeholder personalisation and then calls `bootstrap-local.sh` automatically (choose "local" when prompted).

To run the bootstrap directly (e.g. day-2 cluster recreation):

```bash
./scripts/bootstrap-local.sh
```

What it does (in order):

| Step | What |
|------|------|
| 1 | Starts a local container registry on `localhost:5003` |
| 2 | Creates a Kind cluster (`kind-idp-mvp`) with the registry wired in |
| 3 | Creates platform namespaces and RBAC |
| 4 | Installs nginx ingress controller (host ports 80/443) |
| 4b | Installs metrics-server (required for CPU/memory in Backstage) |
| 4c | Wires Backstage K8s Service + nginx Ingress |
| 5 | Installs Prometheus + Grafana + AlertManager (`kube-prometheus-stack`) |
| 5b | Installs OpenCost |
| 6 | Builds and deploys `hello-service` via the golden-path Helm chart |
| 7 | Writes `/etc/hosts` entries for `*.idp.local` and flushes DNS cache |
| 8 | Installs ArgoCD |
| 9 | Installs OPA/Gatekeeper and applies all five policy constraints |
| 10 | Installs Prometheus Pushgateway + DORA exporter CronJob + catalog exporter CronJob |
| 11 | Deploys Tech Insights Exporter CronJob (scorecard metrics → Pushgateway every 15 min) |
| 12 | Wires AlertManager Slack webhook (if `SLACK_WEBHOOK_URL` is set) |
| 13 | Applies ArgoCD ApplicationSet (manages hello-service, idp-mcp-server, qa-mcp-server in services-dev) and removes the bootstrap-deployed hello-service from services namespace |

### Faster startup flags

```bash
./scripts/bootstrap-local.sh --skip-obs       # skip Prometheus + Grafana
./scripts/bootstrap-local.sh --skip-gitops    # skip ArgoCD
./scripts/bootstrap-local.sh --skip-policies  # skip OPA/Gatekeeper
./scripts/bootstrap-local.sh --skip-dora      # skip DORA exporter
```

Flags can be combined: `--skip-obs --skip-gitops` cuts bootstrap time roughly in half.

## Access services

`/etc/hosts` entries are written automatically by `bootstrap-local.sh`. If you need to add them manually:

```bash
sudo sh -c "cat local/hosts-append.txt >> /etc/hosts"
```

| Service | URL | Credentials |
|---------|-----|-------------|
| **Backstage** | http://backstage.idp.local (or http://localhost:3000) | — (guest mode) |
| **hello-service** | http://hello-service.idp.local | — (managed by ArgoCD in `services-dev` as `hello-service-local-service-template`) |
| **Grafana** | http://grafana.idp.local | `admin` / `admin` |
| **ArgoCD** | http://argocd.idp.local | `admin` / *(see below)* |
| **Prometheus** | http://prometheus.idp.local | — |
| **OpenCost** | http://opencost.idp.local | — |
| **Pushgateway** | http://pushgateway.idp.local | — |
| **Local registry** | localhost:5003 | — (no auth) |

ArgoCD initial admin password:
```bash
kubectl -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath="{.data.password}" | base64 -d
```

Alternatively, use `kubectl port-forward` for any service:
```bash
kubectl port-forward svc/hello-service 8080:80 -n services
```

## Start Backstage

`bootstrap-local.sh` sets up the cluster and platform but does not start Backstage. Run this after the cluster is up:

```bash
./scripts/bootstrap-local.sh --start-backstage
```

This single command:
1. Builds the Backstage Docker image
2. Starts the Docker Compose stack
3. Waits for the container to join the `kind` network
4. Wires the nginx ingress endpoint to the live container IP
5. Seeds sample QA metrics into Pushgateway
6. Triggers an immediate catalog export
7. Prints the full access-URL summary

Backstage is then available at http://backstage.idp.local (or http://localhost:3000 as a direct fallback).

> **Note:** Backstage uses `dangerouslyDisableDefaultAuthPolicy: true` in `app-config.local.yaml` so the catalog loads and is accessible before sign-in completes (prevents 401 flash on first page load in Backstage v1.29+).

### Known platform patches

The Backstage image bundles two repo-local patches that are applied automatically — you do not need to do anything, but knowing they exist saves debugging time:

| Patch | Location | Why it exists |
|---|---|---|
| `@material-table/core` v3 → `uuid` v10 default-export shim | `backstage/app/.yarn/patches/@material-table-core-npm-3.2.5-*.patch` | `uuid` v10 dropped its default export; without the patch, the catalog, api-docs, and techdocs pages crash with `Cannot read properties of undefined (reading 'v4')`. Verify with `grep "uuid.*v4" backstage/app/node_modules/@material-table/core/dist/utils/data-manager.js` — expect `(_uuid["default"] \|\| _uuid).v4()`. |
| `vm2-shim` (replacing abandoned `vm2`) | `backstage/app/vm2-shim/` | `vm2` was pulled in transitively via `typescript-json-schema` → `@backstage/config-loader` and has no upstream security fix. The shim is a thin wrapper over Node's built-in `vm` module and is copied into the image before `yarn workspaces focus` runs. |

Both patches are tracked in git and re-applied automatically by `yarn install` and by the multi-stage `backstage/Dockerfile`. If you ever see catalog tables fail to render or scaffolder actions crash on startup, re-run `yarn install` inside `backstage/app/` and rebuild the image.

### Environment files (first time only)

```bash
cp local/.env.example local/.env
cp local/backstage/.env.example local/backstage/.env
# Edit both and fill in:
#   local/.env          → GITHUB_TOKEN, CLUSTER_NAME, AWS_REGION
#   local/backstage/.env → AUTH_GITHUB_CLIENT_ID, AUTH_GITHUB_CLIENT_SECRET,
#                          BACKSTAGE_AUTH_SECRET (any string locally)
```

> K8s credentials (`K8S_CLUSTER_URL`, `K8S_SERVICE_ACCOUNT_TOKEN`, `K8S_CLUSTER_CA_DATA`) are written to `local/backstage/.env` automatically by `bootstrap-local.sh` via `get-k8s-credentials.sh`. No manual step needed if you bootstrapped with that script.

### Day-2 Backstage restart

If you restart Docker Compose manually, re-run `--start-backstage` to rewire the nginx endpoint:

```bash
./scripts/bootstrap-local.sh --start-backstage
```

Or, if you only need to refresh the IP without reseeding metrics:

```bash
./scripts/bootstrap-local.sh --update-backstage-ip
```

### Manual backend bundle rebuild

Only needed if you changed code under `backstage/app/packages/backend/src/`:

```bash
cd backstage/app && yarn install && yarn build:backend && cd ../..
# Then re-run --start-backstage to pick up the new image
./scripts/bootstrap-local.sh --start-backstage
```

## Deploy a service via Backstage

### Scaffold a new service

1. Open http://backstage.idp.local → **Create**
2. Choose **Node.js Service** or **Python FastAPI Service**
3. Fill in name, description, owner, GitHub repo
4. Click **Create** — Backstage publishes the repo to GitHub and registers it in the catalog

### Deploy to local Kind

The platform includes a custom `idp:deploy-local` action and a dedicated template.

**Prerequisites:**
- Kind cluster and Backstage running (`./scripts/bootstrap-local.sh` then `./scripts/bootstrap-local.sh --start-backstage`)
- Image pushed to local registry (see below)

**Push the image:**
```bash
cd services/<name>
docker build -t localhost:5003/<name>:latest .
docker push localhost:5003/<name>:latest
```

**Deploy via Backstage:**
1. Open http://backstage.idp.local → **Create**
2. Choose **Deploy Service to local Kind cluster**
3. Pick the service from the catalog, set image tag (`latest`)
4. Click **Create**

The action runs `helm upgrade --install` and logs pod status. It connects to Kind via a rewritten kubeconfig (`127.0.0.1` → `host.docker.internal`) mounted into the Backstage container.

**Deploy via CLI (alternative):**
```bash
helm upgrade --install <name> ./helm/service-template \
  --namespace services --create-namespace \
  --set image.repository=localhost:5003/<name> \
  --set image.tag=latest \
  --values services/<name>/helm-values-local.yaml
```

## Scaffold and test a new service locally (CLI path)

```bash
# 1. Scaffold — uses Backstage Scaffolder API when running, local generation otherwise
idp scaffold service --name my-svc --type nodejs

# Force local generation (offline / pre-Backstage)
idp scaffold service --name my-svc --type nodejs --local

# 2. Build and push the image
cd services/my-svc
docker build -t localhost:5003/my-svc:latest .
docker push localhost:5003/my-svc:latest

# 3. Deploy
helm upgrade --install my-svc ./helm/service-template \
  --namespace services --create-namespace \
  --set image.repository=localhost:5003/my-svc \
  --set image.tag=latest \
  --values services/my-svc/helm-values-local.yaml

# 4. Access
# http://my-svc.idp.local  (after /etc/hosts entry)
```

## Local vs AWS — what's different

| Concern | Local | AWS |
|---------|-------|-----|
| Ingress class | `nginx` | `alb` |
| Image pull | `localhost:5003/<name>` | `<account>.dkr.ecr.<region>.amazonaws.com/idp-mvp/<name>` |
| Auth | none | OIDC (GitHub Actions), IRSA (pods) |
| CD trigger | `idp:deploy-local` Backstage action | GitHub Actions push to `main` |
| Observability | Prometheus in-cluster | CloudWatch + Grafana |
| Helm values file | `helm-values-local.yaml` | `helm-values.yaml` |
| Persistent storage | hostPath / emptyDir | EBS (gp2/gp3) |

The Helm chart (`helm/service-template`) is **identical** for both. Only the values file differs.

## AI/ML stack (optional)

After `bootstrap-local.sh` (and optionally `--start-backstage`) completes, boot the AI/ML platform:

```bash
# Requires ANTHROPIC_API_KEY in local/.env
./scripts/bootstrap-ai.sh
```

This installs KAgent (AI agent runtime), the IDP MCP Server, and MLflow.

The AI Assistant at `/ai-assistant` is a **native React chat UI** (not an iframe) that talks directly to the KAgent A2A API via the Backstage proxy.

| Service | URL | Notes |
|---------|-----|-------|
| KAgent UI | http://kagent.idp.local | Direct agent chat UI |
| AI Assistant | http://backstage.idp.local/ai-assistant | Backstage-embedded native React chat UI |
| AI Search | http://backstage.idp.local/ai-search | Semantic search (requires `VOYAGE_API_KEY`) |
| IDP Assistant (A2A) | http://idp-assistant.idp.local | A2A agent endpoint |
| MLflow UI | http://mlflow.idp.local | Experiment tracking |
| IDP MCP Server health | http://idp-mcp-server.idp.local/healthz | MCP server status |

**Skip flags** (combine freely):
```bash
./scripts/bootstrap-ai.sh --skip-mlflow   # skip MLflow
./scripts/bootstrap-ai.sh --skip-kagent   # skip KAgent install
./scripts/bootstrap-ai.sh --skip-mcp      # skip IDP MCP Server build
```

**Tear down AI/ML only** (core platform stays up):
```bash
# Local Kind/Rancher Desktop — removes only local/ ingresses and manifests
./scripts/bootstrap-ai.sh --destroy

# AWS/EKS — removes aws/ ingresses and MLflow AWS overlay
./scripts/bootstrap-ai.sh --aws --destroy
```

> **Warning:** `bootstrap-ai.sh --destroy` scopes deletions to the active
> environment (`--aws` flag). Running without `--aws` while `KUBECONFIG` points
> at EKS will target AWS resources unintentionally.

> **Certificate error on `kagent.idp.local` after `bootstrap-ai.sh`?** The
> KAgent ingresses are HTTP-only as of commit `fe4fce2`. If you ran an earlier
> version of this repo on the same machine, your browser may have cached HSTS
> for `*.idp.local` from the old HTTPS-with-mkcert ingress and will keep
> upgrading the request to HTTPS, against which nginx-ingress responds with a
> fake default cert. Fix: open `chrome://net-internals/#hsts`, **Delete
> domain security policies** for `kagent.idp.local` and
> `idp-assistant.idp.local`, disable *Settings → Privacy → Always use secure
> connections* (or exclude `*.idp.local`), and hard-reload. On a fresh clone
> you'll never hit this.

### Using the AI Assistant in Backstage

Open http://backstage.idp.local/ai-assistant (or click **AI Assistant** in the
sidebar). The assistant can:

- Search the service catalog: *"find all Python services owned by qa-team"*
- Check metrics: *"show request rate for hello-service"*
- List running deployments: *"what's deployed in the services namespace?"*
- Scaffold a new service: *"scaffold a Python FastAPI service called demo, description demo API, owner group:default/platform-team"*

For scaffolding, provide `name`, `description`, and `owner` in one message — the
agent will call the scaffolder immediately without asking for confirmation.

### Enabling AI Search (semantic / RAG)

The `/ai-search` page provides semantic search over the catalog using Voyage AI
embeddings stored in pgvector. To enable it, add your Voyage AI key to
`local/backstage/.env` before starting Backstage:

```bash
VOYAGE_API_KEY=your-key-here   # free tier: 200M tokens/month — voyageai.com
```

The Postgres image used by Docker Compose (`pgvector/pgvector:pg17`) and
`local/backstage/init-pgvector.sql` handle the vector extension and table
automatically on first Postgres startup — no manual SQL step needed.

Without `VOYAGE_API_KEY`, the page loads but search returns HTTP 503. All other
features are unaffected.

See [docs/ai-assistant.md](ai-assistant.md) for the full architecture and
troubleshooting guide.

## Known limitations (local)

| Page | Status | Reason |
|------|--------|--------|
| `/kubernetes` standalone | Disabled | Requires entity context — use the Kubernetes tab on a catalog entity instead |
| `/catalog-graph` | Disabled | Disabled pending fix |
| `/ai-search` | Requires `VOYAGE_API_KEY` | Returns 503 without the key; all other features unaffected |
| Cost Overview | Shows "OpenCost returned 500" if OpenCost is not running | Check `kubectl get pods -n opencost` |

## Teardown

```bash
./scripts/bootstrap-local.sh --destroy
# Removes Kind cluster and local registry container.
# If the kagent/ml-platform/services-dev namespaces exist it calls
# bootstrap-ai.sh --destroy automatically (local scope only — aws/ manifests
# are never touched by this path).
```
