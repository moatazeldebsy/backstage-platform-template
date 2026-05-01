# ${{ values.name }}

${{ values.description }}

Scaffolded via the IDP golden path — Go + distroless, zero external dependencies.

## Local development

```bash
> **Set `PLATFORM_REPO`** to your local `backstage-idp-starter` clone path, e.g.
> `export PLATFORM_REPO=~/projects/backstage-idp-starter`

go test ./src/...
go run ./src/
# service → http://localhost:8080
```

## Docker

```bash
docker build -t ${{ values.name }}:local .
docker run -p 8080:${{ values.port }} ${{ values.name }}:local
```

## Deployment

Push to `main` triggers the GitHub Actions workflow which:
1. Runs `go test ./src/...`
2. Builds and smoke-tests the Docker image
3. On success: pushes to ECR and deploys to EKS via Helm

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
