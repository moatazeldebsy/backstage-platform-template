# ${{ values.name }}

${{ values.description }}

Scaffolded via the IDP golden path — React + Vite + TypeScript, served by nginx.

| Property | Value |
|----------|-------|
| Owner | `${{ values.owner }}` |
| Port | `80` (container) / `${{ values.port }}` (host) |
| Language | React / TypeScript |

---

## Local Development

> **Run these commands inside your cloned service repo:**
> `git clone https://github.com/${{ values.githubOrg }}/${{ values.repoName }} && cd ${{ values.repoName }}`

```bash
npm install
npm run dev    # Vite dev server → http://localhost:5173
npm test       # Vitest
npm run build  # Production bundle → dist/
```

### Docker (optional — test the nginx container locally)

> **Run in your cloned service repo.**

```bash
docker build -t ${{ values.name }}:local .
docker run -p ${{ values.port }}:80 ${{ values.name }}:local
# → http://localhost:${{ values.port }}
# → http://localhost:${{ values.port }}/healthz
```

---

## Local Development (Kind)

This deploys your frontend into the local Kind cluster managed by the platform.

**Two repos are involved — be clear about which terminal you are in:**

| Repo | Purpose |
|------|---------|
| **This repo** (`${{ values.repoName }}/`) | Your app code, `Dockerfile`, `helm-values-local.yaml` |
| **Platform repo** (`backstage-idp-starter/`) | Shared Helm chart (`helm/service-template/`) used by all services |

### Step 1 — In your cloned service repo: build and push the image

```bash
# cd ${{ values.repoName }}
docker build -t localhost:5003/${{ values.name }}:local .
docker push localhost:5003/${{ values.name }}:local
```

### Step 2 — In your cloned service repo: deploy with Helm

Point `PLATFORM_REPO` at your local `backstage-idp-starter` clone, then run `helm upgrade` from **this repo** (so Helm can find `helm-values-local.yaml`):

```bash
# cd ${{ values.repoName }}
export PLATFORM_REPO=~/projects/backstage-idp-starter   # adjust path if needed

helm upgrade --install ${{ values.name }} ${PLATFORM_REPO}/helm/service-template \
  --namespace services \
  --create-namespace \
  --values helm-values-local.yaml
```

### Step 3 — Add the hostname to `/etc/hosts` (once)

```bash
echo "127.0.0.1  ${{ values.name }}.idp.local" | sudo tee -a /etc/hosts
```

Your frontend is now live at **http://${{ values.name }}.idp.local**

---

## Deploying (CI/CD + GitOps)

Everything below is **fully automated** once you push to `main`. You do not need to run Helm manually for CI/CD deployments.

### How it works

```
Push to main (this repo)
  └─▶ GitHub Actions (.github/workflows/build-and-deploy.yml)
        ├─ npm test
        ├─ npm run build
        ├─ docker build + smoke-test /healthz
        ├─ docker push → GHCR (ghcr.io/${{ values.githubOrg }}/${{ values.name }})
        └─ updates helm-values-dev.yaml in backstage-idp-starter  ← platform repo
              └─▶ ArgoCD detects the change and deploys to the Kind/EKS cluster
```

### Required GitHub Secrets

Set these in **this repo's** Settings → Secrets and variables → Actions:

| Secret | Required | Purpose |
|--------|----------|---------|
| `GH_PAT` | Yes | Allows CI to commit the new image tag to `backstage-idp-starter` |
| `AWS_ROLE_ARN` | AWS only | IAM role for ECR push (`terraform output github_actions_role_arn` in platform repo) |

Without `GH_PAT` the `update-image-tag` step is skipped and ArgoCD won't auto-deploy.

### Manual Helm deploy (escape hatch)

Only needed if CI is broken or you want to deploy a specific image by hand.

```bash
# Local Kind — run from your cloned service repo
export PLATFORM_REPO=~/projects/backstage-idp-starter
helm upgrade --install ${{ values.name }} ${PLATFORM_REPO}/helm/service-template \
  --namespace services \
  --values helm-values-local.yaml

# AWS EKS — run from your cloned service repo
helm upgrade --install ${{ values.name }} ${PLATFORM_REPO}/helm/service-template \
  --namespace services \
  --set image.repository=<ECR_URI>/${{ values.name }} \
  --set image.tag=<git-sha> \
  --values helm-values.yaml
```

---

## Project Structure

```
${{ values.name }}/              ← this repo (your frontend)
├── src/
├── public/
├── Dockerfile
├── package.json
├── vite.config.ts
├── helm-values.yaml             # AWS / ALB overrides (referenced by CI)
├── helm-values-local.yaml       # Kind / nginx overrides (referenced by local Helm)
├── catalog-info.yaml            # Backstage component descriptor
└── docs/

backstage-idp-starter/           ← platform repo (separate clone)
└── helm/service-template/       # Shared Helm chart used by ALL services
```

## Links

- [Backstage catalog entry](http://backstage.idp.local/catalog/default/component/${{ values.name }})
- [GitHub repository](https://github.com/${{ values.githubOrg }}/${{ values.repoName }})
- [ArgoCD app](http://argocd.idp.local)
