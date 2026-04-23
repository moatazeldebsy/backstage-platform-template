# ImagePullBackOff / Back-off pulling image Runbook

## Symptoms

- Pod state is `ImagePullBackOff` or `ErrImagePull` in `kubectl get pods`
- Backstage Kubernetes tab shows: **"Back-off pulling image `localhost:5003/<service>:latest`"**
- ArgoCD shows the app as `Degraded`

## Root Cause

The image referenced in `helm-values-dev.yaml` (or `helm-values-local.yaml`) does not exist in the local registry at `localhost:5003`. This happens when:

1. A new service was scaffolded via Backstage or `create-service.sh` and the PR was merged — but the Docker image was **never built and pushed** to the local registry.
2. The local Kind cluster was destroyed and recreated (`bootstrap-local.sh --destroy` + re-bootstrap) — all registry contents are lost.

## Fix (Local Kind Cluster)

### Step 1 — Clone the service repository

The service source lives in its own GitHub repo (created by the Backstage scaffold):

```bash
git clone https://github.com/<your-org>/<service-name>.git
cd <service-name>
```

### Step 2 — Build the Docker image

```bash
docker build -t localhost:5003/<service-name>:latest .
```

### Step 3 — Push to the local registry

```bash
docker push localhost:5003/<service-name>:latest
```

> The Kind cluster's `containerdConfigPatches` (see `local/kind-config.yaml`) rewrites `localhost:5003` → `registry:5000` inside the cluster nodes, so this address is correct.

### Step 4 — Restart the pod / re-sync ArgoCD

```bash
# Force a rollout so Kubernetes re-evaluates the image
kubectl rollout restart deployment/<service-name>-dev-service-template -n services-dev

# Verify pods come up
kubectl get pods -n services-dev -w
```

Or from the **ArgoCD UI**: open the app and click **Sync**.

### Step 5 — Verify in Backstage

Reload the service's **Kubernetes** tab in Backstage — the pod state should change from `ImagePullBackOff` to `Running` with "No pods with errors".

## Fix (AWS / EKS)

On AWS the image must exist in ECR. The CD pipeline in the service repo handles this automatically on push to `main`. If the image is missing:

```bash
# Authenticate Docker to ECR
aws ecr get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin \
    <account-id>.dkr.ecr.us-east-1.amazonaws.com

# Build and push
docker build -t <account-id>.dkr.ecr.us-east-1.amazonaws.com/idp-mvp/<service-name>:latest .
docker push <account-id>.dkr.ecr.us-east-1.amazonaws.com/idp-mvp/<service-name>:latest

# Restart the deployment
kubectl rollout restart deployment/<service-name> -n services
```

## Prevention

- After merging a scaffold PR, always push the Docker image (or trigger the service repo's CI/CD pipeline) before expecting pods to be healthy.
- Use `tilt up` (from the service directory, if a `Tiltfile` is present) to get automatic image rebuilds on code changes during local development.
- On local cluster teardown + recreate (`bootstrap-local.sh --destroy`), re-push all service images before re-syncing ArgoCD.

## Related Runbooks

- [Pod Crash Loop](pod-crash-loop.md)
- [Deployment Rollback](deployment-rollback.md)
