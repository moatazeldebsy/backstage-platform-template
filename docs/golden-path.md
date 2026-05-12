# Golden Path: From Template to Running Service

The golden path is the single, opinionated workflow every developer follows to ship a service. No decisions about CI, container registries, deployment targets, or monitoring — the platform handles those.

## The Journey (end-to-end)

### Local (Kind)

```
Developer                Platform
─────────                ────────
1. Open Backstage (http://backstage.idp.local)
2. Choose template ──────> Scaffolder creates GitHub repo + README
3. Clone & code          > CI workflow is pre-wired (test + smoke-check)
4. git push ─────────────> GitHub Actions: install → test → docker build → /healthz check
5. Push image to registry
   docker push localhost:5003/<name>:latest
6. Open Backstage ───────> Create → "Deploy Service to local Kind cluster"
                         > idp:deploy-local action runs helm upgrade --install
7. Done — service live   > http://<name>.idp.local
```

### AWS (planned)

```
Developer                Platform
─────────                ────────
1. Open Backstage
2. Choose template ──────> Scaffolder creates GitHub repo + README
3. Clone & code          > CI/CD workflow is pre-wired
4. Add AWS secrets ──────> AWS_ROLE_ARN in repo settings
5. git push ─────────────> GitHub Actions triggers
                         > Build Docker image
                         > Push to Amazon ECR
                         > helm upgrade --install on EKS
                         > Deployment verified
6. Done — service live   > Logs/metrics in CloudWatch + Grafana
```

## Step-by-Step for Developers

### 1. Pick a template in Backstage

Open the Backstage portal and click **Create** → select one of:

| Template | Language | Default Port |
|----------|----------|-------------|
| Node.js Service | Express | 3000 |
| Python FastAPI Service | FastAPI + uvicorn | 8000 |

Fill in name, description, owner, and GitHub repo. Click **Create**.

Backstage will:
- Fetch the skeleton and render it with your values
- Publish the repo to GitHub
- Register the component and API in the catalog

### 2. Clone your new repo

```bash
git clone https://github.com/YOUR_ORG/<service-name>
cd <service-name>
```

### 3. Implement your service

The skeleton contains:
```
<service-name>/
├── src/               # Application code
├── Dockerfile         # node:22-alpine (Node.js) or python:3.12 (FastAPI)
├── README.md          # Auto-generated with endpoints, commands, deploy steps
├── helm-values.yaml       # AWS / ALB overrides
├── helm-values-local.yaml # Kind / nginx overrides
├── catalog-info.yaml      # Backstage component registration
├── api-info.yaml          # Backstage API registration
└── .github/
    └── workflows/
        └── build-and-deploy.yml  # CI: test + smoke-check
```

**Conventions** (enforced by the platform):

| Convention | Value |
|-----------|-------|
| Liveness path | `GET /healthz` → `200 {"status":"ok"}` |
| Readiness path | `GET /ready` → `200 {"status":"ready"}` |
| Metrics path | `GET /metrics` → Prometheus text format |
| Logs | Structured JSON to stdout |
| Namespace | `services` |

### 4. Push to trigger CI

```bash
git add .
git commit -m "feat: initial implementation"
git push origin main
```

GitHub Actions (`test` job on `ubuntu-latest`) will:
1. Install dependencies (`npm install` / `pip install`)
2. Run tests (passes if no tests exist yet)
3. Build the Docker image (smoke check)
4. Start the container and `curl` `/healthz` and `/ready`

### 5. Deploy to local Kind

```bash
# Build and push the image to the local registry
docker build -t localhost:5003/<name>:latest .
docker push localhost:5003/<name>:latest
```

Then in Backstage → **Create** → **Deploy Service to local Kind cluster**:
- Pick the service from the catalog
- Set image tag (`latest`)
- Click **Create**

Or via CLI:
```bash
helm upgrade --install <name> ./helm/service-template \
  --namespace services --create-namespace \
  --set image.repository=localhost:5003/<name> \
  --set image.tag=latest \
  --values services/<name>/helm-values-local.yaml
```

Access the service at `http://<name>.idp.local` (add to `/etc/hosts` if needed).

### 6. Deploy to AWS (when ready)

Add repo secrets:

| Secret | Value |
|--------|-------|
| `AWS_ROLE_ARN` | `terraform output github_actions_role_arn` |
| `AWS_REGION` | `us-east-1` |
| `ECR_REGISTRY` | `<account>.dkr.ecr.us-east-1.amazonaws.com` |
| `EKS_CLUSTER` | `idp-mvp` |

Then re-add the deploy job to `.github/workflows/build-and-deploy.yml` (see `docs/getting-started.md`).

### 7. Monitor your service

- **Local**: Grafana → http://grafana.idp.local (admin/admin)
- **AWS**: CloudWatch → Log Groups → `/aws/containerinsights/idp-mvp/application`
- **Metrics**: Grafana → IDP Services dashboard

## Conventions Reference

| Convention | Local | AWS |
|-----------|-------|-----|
| Namespace | `services` | `services` |
| Image registry | `localhost:5003/<name>` | `<account>.dkr.ecr.<region>.amazonaws.com/idp-mvp/<name>` |
| Image tag | `latest` (local push) | `<git-sha-short>` |
| Ingress class | `nginx` | `alb` |
| Replicas | 1 | 2 |
| CPU request | 50m | 100m |
| Memory request | 32Mi | 128Mi |

## CLI Alternative (without Backstage)

```bash
# Scaffold — auto-detects Backstage; falls back to local generation
idp scaffold service --name my-service --type nodejs

# Force local generation (offline / pre-Backstage)
idp scaffold service --name my-service --type nodejs --local

# Deploy locally
docker build -t localhost:5003/my-service:latest services/my-service/
docker push localhost:5003/my-service:latest
helm upgrade --install my-service ./helm/service-template \
  --namespace services --create-namespace \
  --set image.repository=localhost:5003/my-service \
  --set image.tag=latest \
  --values services/my-service/helm-values-local.yaml
```
