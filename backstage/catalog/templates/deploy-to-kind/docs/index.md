# Deploy Service to local Kind cluster

This template deploys an **existing** service to the local [Kind](https://kind.sigs.k8s.io/) Kubernetes cluster using Helm.

Run it from the **Create** page in Backstage any time after scaffolding a service.

## Prerequisites

- Local Kind cluster running (`./scripts/bootstrap-local.sh`)
- Service Docker image pushed to the local registry (`localhost:5003/<name>:latest`)
- `helm` and `kubectl` available in the Backstage container

## What it does

1. Runs `helm upgrade --install` against the local Kind cluster
2. Uses the shared `helm/service-template` chart with values you provide
3. Creates the service in the `services` namespace
4. The service is immediately accessible via the local ingress at `http://<name>.idp.local`

## Push image first

```bash
docker build -t localhost:5003/<name>:latest .
docker push localhost:5003/<name>:latest
```

## Health checks

After deploying, the service should respond at:

- `http://<name>.idp.local/healthz` — liveness
- `http://<name>.idp.local/ready` — readiness
- `http://<name>.idp.local/metrics` — Prometheus metrics
