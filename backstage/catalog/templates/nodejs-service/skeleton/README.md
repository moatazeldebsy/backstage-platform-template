# ${{ values.name }}

${{ values.description }}

## Overview

This service was scaffolded via the IDP golden path (Node.js/Express template).

| Property | Value |
|----------|-------|
| Owner | `${{ values.owner }}` |
| Port | `${{ values.port }}` |
| Language | Node.js / Express |

## Getting Started

```bash
npm install
npm start
```

The service listens on port `${{ values.port }}` by default (override with the `PORT` env var).

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Root — returns service name and status |
| `GET /healthz` | Liveness probe |
| `GET /ready` | Readiness probe |
| `GET /metrics` | Prometheus metrics |

## Running Tests

```bash
npm test
```

## Local Development (Kind)

```bash
# From the repo root — hot-reload dev loop
tilt up

# Access the service
http://${{ values.name }}.idp.local
```

Add `${{ values.name }}.idp.local` to `/etc/hosts` pointing to `127.0.0.1` if not already present.

## Deploying

CI/CD is wired via GitHub Actions (`.github/workflows/build-and-deploy.yml`). Push to `main` to trigger a build and deploy.

```bash
# Manual Helm deploy (local)
helm upgrade --install ${{ values.name }} ../../helm/service-template \
  --namespace services \
  --set image.repository=localhost:5003/${{ values.name }} \
  --set image.tag=latest \
  --values helm-values-local.yaml

# Manual Helm deploy (AWS)
helm upgrade --install ${{ values.name }} ../../helm/service-template \
  --namespace services \
  --set image.repository=<ECR_URI>/${{ values.name }} \
  --set image.tag=<git-sha> \
  --values helm-values.yaml
```

## Project Structure

```
${{ values.name }}/
├── src/
│   └── index.js        # Application entry point
├── Dockerfile
├── package.json
├── helm-values.yaml        # AWS / ALB overrides
├── helm-values-local.yaml  # Kind / nginx overrides
├── catalog-info.yaml       # Backstage component descriptor
├── api-info.yaml           # Backstage API descriptor
└── docs/
    ├── index.md
    └── adr/
        └── 0001-initial-decisions.md
```

## Required GitHub Secrets

Set these in your repository's **Settings → Secrets and variables → Actions**:

| Secret | Required | Purpose |
|--------|----------|---------|
| `GH_PAT` | Yes | Personal access token (`repo` scope) — CI pushes the updated image tag back to the platform repo to trigger GitOps |
| `AWS_ROLE_ARN` | AWS only | IAM role ARN for ECR push (`terraform output github_actions_role_arn`) |

Without `GH_PAT` the `update-image-tag` CI step will be skipped and ArgoCD won't pick up new builds automatically.

## Links

- [Backstage catalog entry](https://backstage.${{ values.githubOrg }}.internal/catalog/default/component/${{ values.name }})
- [GitHub repository](https://github.com/${{ values.githubOrg }}/${{ values.repoName }})
