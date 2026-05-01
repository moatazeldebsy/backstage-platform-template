# ${{ values.name }}

${{ values.description }}

Scaffolded via the IDP golden path — React + Vite + TypeScript, served by nginx.

## Local development

```bash
> **Set `PLATFORM_REPO`** to your local `backstage-idp-starter` clone path, e.g.
> `export PLATFORM_REPO=~/projects/backstage-idp-starter`

npm install
npm run dev        # Vite dev server → http://localhost:5173
npm test           # Vitest
npm run build      # Production bundle → dist/
```

## Docker

```bash
docker build -t ${{ values.name }}:local .
docker run -p 8080:80 ${{ values.name }}:local
# App → http://localhost:8080
# Health → http://localhost:8080/healthz
```

## Deployment

Push to `main` triggers the GitHub Actions workflow which:
1. Runs tests
2. Builds the bundle (`npm run build`)
3. Builds and smoke-tests the Docker image
4. On success: pushes to ECR and deploys to EKS via Helm

## Required GitHub Secrets

Set these in your repository's **Settings → Secrets and variables → Actions**:

| Secret | Required | Purpose |
|--------|----------|---------|
| `GH_PAT` | Yes | Personal access token (`repo` scope) — CI pushes the updated image tag back to the platform repo to trigger GitOps |
| `AWS_ROLE_ARN` | AWS only | IAM role ARN for ECR push (`terraform output github_actions_role_arn`) |

Without `GH_PAT` the `update-image-tag` CI step will be skipped and ArgoCD won't pick up new builds automatically.

## Helm

Set `PLATFORM_REPO` to your local `backstage-idp-starter` clone before running:

```bash
export PLATFORM_REPO=~/projects/backstage-idp-starter
```




```bash
# Local Kind cluster
helm upgrade --install ${{ values.name }} ${PLATFORM_REPO}/helm/service-template \
  --namespace services \
  --create-namespace \
  --values helm-values-local.yaml

# AWS EKS
helm upgrade --install ${{ values.name }} ${PLATFORM_REPO}/helm/service-template \
  --namespace services \
  --create-namespace \
  --values helm-values.yaml \
  --set image.repository=<ecr-url>/${{ values.name }} \
  --set image.tag=<git-sha>
```
