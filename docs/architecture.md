# Platform Architecture

## Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                       Developer Experience                           │
│  ┌──────────────────┐  ┌──────────────┐  ┌────────────────────────┐ │
│  │  Backstage        │  │  GitHub      │  │  create-service.sh     │ │
│  │  Portal           │  │  (source)    │  │  (CLI scaffold)        │ │
│  │  + custom actions │  └──────┬───────┘  └────────────────────────┘ │
│  └──────┬───────┬────┘         │ push                                │
└─────────┼───────┼──────────────┼─────────────────────────────────────┘
          │       │              │
  scaffold│  deploy              │ push
          │  (idp:deploy-local)  ▼
          │       │   ┌──────────────────────────────────────────┐
          │       │   │           CI/CD Layer                    │
          │       │   │  GitHub Actions (ubuntu-latest)          │
          │       │   │  install → test → docker build → /healthz│
          │       │   └────────────────┬─────────────────────────┘
          │       │                    │ (AWS CD — planned)
          ▼       ▼                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│               Local: Kind cluster  /  AWS: EKS                      │
│                                                                      │
│  namespace: services              namespace: monitoring              │
│  ┌──────────────────────┐         ┌────────────────────────────────┐ │
│  │ Deployments (Helm)   │         │ Prometheus + Grafana (local)   │ │
│  │ Services             │         │ CloudWatch agent (AWS)         │ │
│  │ Ingress (nginx/ALB)  │         └────────────────────────────────┘ │
│  └──────────────────────┘                                            │
└─────────────────────────────────────────────────────────────────────┘
                    │ (AWS only)
                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                 AWS Infrastructure (Terraform)                       │
│   VPC → Private/Public Subnets → EKS → ECR → IAM (OIDC/IRSA)      │
└─────────────────────────────────────────────────────────────────────┘
```

## Key Design Decisions

### Convention over configuration
Every service gets the same: container registry, CI workflow, Helm chart structure, health check paths, namespace, and monitoring. Developers don't configure these — they inherit them from the golden path.

### Helm as the single deployment abstraction
The `helm/service-template` chart is the single deployment unit for both local (Kind) and cloud (EKS). Service teams only override their `helm-values.yaml` or `helm-values-local.yaml` — no raw Kubernetes YAML.

### CI only in GitHub Actions (for now)
Scaffolded service workflows run `test` on `ubuntu-latest`. No self-hosted runners are required. CD is handled by the `idp:deploy-local` Backstage action (local) or will be added as an AWS deploy job when secrets are configured.

### Custom Backstage action for local deploy
`idp:deploy-local` is a backend module registered in the Backstage scaffolder. It runs `helm upgrade --install` from inside the Backstage container using a kubeconfig rewritten to reach the host's Kind cluster via `host.docker.internal`.

### OIDC for keyless CI/CD auth (AWS)
GitHub Actions authenticates to AWS via OIDC (`aws-actions/configure-aws-credentials`), eliminating long-lived secrets. The IAM role is scoped to the specific GitHub org.

### IRSA for pod-level AWS access
Kubernetes service accounts are annotated with IAM role ARNs. Pods assume fine-grained IAM roles without node-level credentials (EKS IRSA).

### AWS Load Balancer Controller (AWS)
All `Ingress` resources use `ingressClassName: alb`, backed by the AWS Load Balancer Controller. Supports `target-type: ip` (pod-level routing without NodePort).

## Component Inventory

| Component | Path | Purpose |
|-----------|------|---------|
| EKS cluster | `terraform/eks.tf` | Cloud compute platform |
| VPC | `terraform/vpc.tf` | Network isolation |
| ECR | `terraform/ecr.tf` | Cloud container registry |
| IAM + OIDC | `terraform/iam.tf` | Keyless CI/CD auth |
| Service chart | `helm/service-template/` | Deployment template (local + AWS) |
| Platform CI/CD | `.github/workflows/build-and-deploy.yml` | Root platform pipeline |
| Backstage config | `backstage/app-config.yaml` | Portal configuration |
| Backstage local config | `backstage/app-config.local.yaml` | Local overrides (guest auth, local techdocs) |
| Node.js template | `backstage/catalog/templates/nodejs-service/` | Express service scaffold |
| Python template | `backstage/catalog/templates/python-service/` | FastAPI service scaffold |
| Deploy-to-Kind template | `backstage/catalog/templates/deploy-to-kind/` | Standalone local deploy |
| `idp:deploy-local` action | `backstage/app/packages/backend/src/modules/idpLocalDeploy.ts` | Custom scaffolder action |
| Backstage image | `backstage/Dockerfile` | Production image (pre-built bundle) |
| CloudWatch agent | `observability/cloudwatch/` | Log/metric collection (AWS) |
| Grafana | `observability/grafana/` | Visualization (both envs) |
| hello-service | `services/hello-service/` | Reference Go implementation |

## Backstage Custom Action: `idp:deploy-local`

```
Backstage UI
  → "Deploy Service to local Kind cluster" template
    → idp:deploy-local action
      → kubectl cluster-info  (verify Kind reachable)
      → helm upgrade --install <name> /helm/service-template \
            --set image.repository=localhost:5003/<name> \
            --set image.tag=<tag> \
            --set ingress.className=nginx \
            --set ingress.hosts[0].host=<name>.idp.local \
            ...
      → kubectl get pods  (log status)
      → output: serviceUrl = http://<name>.idp.local
```

**Kubeconfig bridge (macOS + Docker Desktop):**

```
Host ~/.kube/config         docker-compose mounts as read-only
  (server: 127.0.0.1:PORT)  ───────────────────────────────────>  /home/node/.kube/config
                                                                          │
                                                          startup sed rewrites:
                                                          127.0.0.1 → host.docker.internal
                                                          strips certificate-authority-data
                                                          adds insecure-skip-tls-verify: true
                                                                          │
                                                                          ▼
                                                                   /tmp/kubeconfig
                                                          KUBECONFIG=/tmp/kubeconfig (env)
```
