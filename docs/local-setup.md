# Local Setup (Kind)

Run the full IDP platform on your laptop — no AWS account required.

## Prerequisites

```bash
# macOS
brew install kind kubectl helm docker

# Verify
kind version    # >= 0.22
kubectl version --client
helm version    # >= 3.14
docker info     # Docker running
```

> **macOS ARM64 note**: The cluster is pinned to K8s **1.31.6** (`kindest/node:v1.31.6`).
> K8s 1.35 (Kind's current default) has kubelet cgroup issues with Docker Desktop on Apple Silicon.

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
| 5 | Installs Prometheus + Grafana (`kube-prometheus-stack`) |
| 6 | Builds and deploys `hello-service` via the golden-path Helm chart |
| 7 | Writes `/etc/hosts` entries for `*.idp.local` and flushes DNS cache |
| 8 | Installs ArgoCD |
| 9 | Installs OPA/Gatekeeper and applies all policy constraints |
| 10 | Deploys OpenCost |
| 11 | Installs Prometheus Pushgateway + DORA exporter CronJob |
| 12 | Wires AlertManager Slack webhook (if `SLACK_WEBHOOK_URL` is set) |
| 13 | Applies ArgoCD ApplicationSet (hello-service → local/dev/staging/prod) |

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
| **hello-service** | http://hello-service.idp.local | — |
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

## Start Backstage (required after every bootstrap)

`bootstrap-local.sh` only wires the nginx ingress for Backstage on the Kind side. It does **not** build or start the Docker Compose stack. You will see a **502 Bad Gateway** at `http://backstage.idp.local` until the containers are running.

### Environment files (first time only)

```bash
cp local/.env.example local/.env
cp local/backstage/.env.example local/backstage/.env
# Edit both and fill in:
#   local/.env          → GITHUB_TOKEN, CLUSTER_NAME, AWS_REGION
#   local/backstage/.env → AUTH_GITHUB_CLIENT_ID, AUTH_GITHUB_CLIENT_SECRET,
#                          BACKSTAGE_AUTH_SECRET (any string locally),
#                          K8s credentials (run get-k8s-credentials.sh, see below)
```

### Build and start

```bash
# 1. Build the backend bundle (required before docker build, and after any backend code change)
cd backstage/app && yarn install && yarn build:backend && cd ../..

# 2. Build the Docker image and start the stack
docker compose -f local/backstage/docker-compose.yml build backstage
docker compose -f local/backstage/docker-compose.yml up -d

# Backstage is now at http://localhost:3000
```

### Fix 502 on backstage.idp.local

nginx proxies to the Backstage container's IP on the `kind` Docker network. After `docker compose up -d`, update the K8s endpoint to match the live container IP:

```bash
./scripts/bootstrap-local.sh --update-backstage-ip
```

The `docker-compose.yml` declares the `kind` network so the container is automatically reachable from inside the cluster. No manual `docker network connect` is needed.

### Wire K8s credentials into Backstage

Needed for the Kubernetes tab and `idp:deploy-local` action:

```bash
./scripts/get-k8s-credentials.sh
# Writes K8S_CLUSTER_URL, K8S_SERVICE_ACCOUNT_TOKEN, K8S_CLUSTER_CA_DATA to local/backstage/.env
# Then restart: docker compose -f local/backstage/docker-compose.yml restart backstage
```

> `bootstrap-local.sh` (and therefore `setup.sh`) runs `get-k8s-credentials.sh` automatically. The manual step above is only needed if you provisioned the cluster without `bootstrap-local.sh`. `--update-backstage-ip` is still required manually after `docker compose up -d`.

## Deploy a service via Backstage

### Scaffold a new service

1. Open http://localhost:3000 → **Create**
2. Choose **Node.js Service** or **Python FastAPI Service**
3. Fill in name, description, owner, GitHub repo
4. Click **Create** — Backstage publishes the repo to GitHub and registers it in the catalog

### Deploy to local Kind

The platform includes a custom `idp:deploy-local` action and a dedicated template.

**Prerequisites:**
- Kind cluster running (`./scripts/bootstrap-local.sh`)
- Image pushed to local registry (see below)

**Push the image:**
```bash
cd services/<name>
docker build -t localhost:5003/<name>:latest .
docker push localhost:5003/<name>:latest
```

**Deploy via Backstage:**
1. Open http://localhost:3000 → **Create**
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
# 1. Scaffold
./scripts/create-service.sh --name my-svc --type nodejs

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

## Teardown

```bash
./scripts/bootstrap-local.sh --destroy
# Removes Kind cluster and local registry container
```
