# Local Setup (Kind)

Run the full IDP platform on your laptop — no AWS account required.

## Prerequisites

```bash
# macOS
brew install kind kubectl helm docker
brew install tilt  # optional — only needed for hot-reload dev loop

# Verify
kind version    # >= 0.22
kubectl version --client
helm version    # >= 3.14
docker info     # Docker running
```

> **macOS ARM64 note**: The cluster is pinned to K8s **1.31.6** (`kindest/node:v1.31.6`).
> K8s 1.35 (Kind's current default) has kubelet cgroup issues with Docker Desktop on Apple Silicon.

## Bootstrap (~5 min)

```bash
./scripts/bootstrap-local.sh
```

What it does:
1. Starts a local container registry on `localhost:5003`
2. Creates a 3-node Kind cluster (`kind-idp-mvp`) with the registry wired in
3. Installs nginx ingress controller on the control-plane node (port 80/443)
4. Installs Prometheus + Grafana via `kube-prometheus-stack`
5. Builds and deploys `hello-service` using the golden-path Helm chart

To skip observability for a faster startup:
```bash
./scripts/bootstrap-local.sh --skip-obs
```

## Access services

Add to `/etc/hosts`:
```bash
sudo sh -c "cat local/hosts-append.txt >> /etc/hosts"
```

| Service | URL | Credentials |
|---------|-----|-------------|
| hello-service | http://hello-service.idp.local | — |
| Grafana | http://grafana.idp.local | admin / admin |
| Backstage | http://localhost:3000 (after step below) | — |

Alternatively, use `kubectl port-forward`:
```bash
kubectl port-forward svc/hello-service 8080:80 -n services
```

## Hot-reload development with Tilt

Once the cluster is running:
```bash
tilt up
```

Tilt watches your source files. When you edit `services/hello-service/src/main.go`, it rebuilds the image, pushes to the local registry, and Helm-upgrades the deployment — usually in under 10 seconds.

Open the Tilt UI at http://localhost:10350 to see build logs and pod status.

## Run Backstage locally

Backstage requires a pre-built backend bundle before the Docker image can be built.

```bash
# 1. Install dependencies and build the backend
cd backstage/app
yarn install
yarn build:backend
cd ../..

# 2. Configure environment
cp local/backstage/.env.example local/backstage/.env
# Edit .env — set GITHUB_TOKEN (needs repo scope to publish scaffolded repos)

# 3. Build and start
docker compose -f local/backstage/docker-compose.yml build backstage
docker compose -f local/backstage/docker-compose.yml up -d

# Backstage UI: http://localhost:3000
```

> After any change to `backstage/app/packages/backend/src/`, repeat steps 1 (`yarn build:backend`) and 3 (`docker compose build + up`).

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

# 2. Add to Tiltfile (snippet printed by the script), then:
tilt up

# 3. Access
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
