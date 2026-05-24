# Getting Started

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| AWS CLI | ≥ 2.15 | `brew install awscli` |
| Terraform | ≥ 1.5 | `brew install terraform` |
| kubectl | ≥ 1.29 | `brew install kubectl` |
| Helm | ≥ 3.14 | `brew install helm` |
| Docker | ≥ 24 | docker.com |
| Node.js | ≥ 22 | `brew install node` (for Backstage build) |

## Local Setup (no AWS needed)

See [docs/local-setup.md](local-setup.md) for the full local walkthrough including Backstage, the `idp:deploy-local` action, and Kind deployment.

`./scripts/setup.sh` **must be run before** `bootstrap-local.sh`. It replaces `moatazeldebsy` and other placeholders across 542 targeted files (excluding node_modules). Without it, the ArgoCD ApplicationSet will have an unresolved placeholder and generate no apps.

> **Important:** `setup.sh` uses targeted file scanning and `while`-loop replacement (not `xargs`) to reliably update placeholders. If you previously ran an older version and ArgoCD shows no apps, check that `local/argocd/app-of-apps-local.yaml` contains your GitHub org (not `moatazeldebsy`), then re-run `setup.sh`.

## AWS Setup

> **🔐 CRITICAL - First:** Read [docs/PRE_DEPLOYMENT_CHECKLIST.md](PRE_DEPLOYMENT_CHECKLIST.md) and verify all API keys are set correctly. Run `./scripts/verify-secrets.sh` to validate before deployment.

> **⚠️ NEW:** Then read [docs/DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) for a complete step-by-step guide, pre-flight checklist, known issues with solutions, and troubleshooting. Estimated deployment time: **45–60 minutes**.

### 1. Configure AWS

```bash
aws configure  # or use aws sso login
aws sts get-caller-identity  # verify
```

### 2. Bootstrap the platform

```bash
git clone https://github.com/moatazeldebsy/idp-mvp
cd idp-mvp

# Run the interactive setup wizard (personalises placeholders, then bootstraps AWS)
./scripts/setup.sh
# → Choose "aws" when prompted for environment
```

Or, if you have already run `setup.sh` for personalisation and want to re-run the AWS bootstrap directly:

```bash
cp terraform/terraform.tfvars.example terraform/terraform.tfvars
# Edit terraform/terraform.tfvars — update cluster_name, region if needed
./scripts/bootstrap.sh  # ~45–60 min
```

### 3. Validate deployment

After `bootstrap.sh` completes, run the validation script to verify all components:

```bash
./scripts/validate-deployment.sh
```

This runs 50+ automated tests across 10 categories (AWS infrastructure, Kubernetes, Backstage, observability, GitOps, AI/ML, security, networking, storage, and cost). Exit code 0 = success; 1 = failure with debug suggestions.

### 4. Clean up (when done)

To safely tear down all AWS resources:

```bash
./scripts/cleanup.sh --cluster-name idp-mvp
```

This script deletes orphaned load balancers first, then runs `terraform destroy` with verification.

---

**What gets provisioned:**
- EKS cluster (4× t3.medium nodes, 1.29)
- RDS PostgreSQL (for Backstage)
- ECR repository + S3 bucket (for artifacts)
- IAM roles + OIDC (for GitHub Actions and Crossplane)
- All platform components (Prometheus, Grafana, ArgoCD, OPA/Gatekeeper, External Secrets Operator)
- Crossplane with AWS providers (for per-service resources like S3, RDS, DynamoDB)
- `hello-service` reference deployment

**Cost:** ~$248/month for a development environment (4 nodes running continuously). See [IMPROVEMENTS_SUMMARY.md](IMPROVEMENTS_SUMMARY.md) for cost optimization strategies.

### 3. GitHub Actions secrets

Add these secrets to any scaffolded service repo to enable AWS CD:

| Secret | Value |
|--------|-------|
| `AWS_ROLE_ARN` | `cd terraform && terraform output github_actions_role_arn` |
| `AWS_REGION` | `us-east-1` |
| `ECR_REGISTRY` | `<account>.dkr.ecr.us-east-1.amazonaws.com` |
| `EKS_CLUSTER` | `idp-mvp` |

### 4. Verify

```bash
kubectl get pods -n services              # hello-service running
kubectl get pods -n monitoring            # prometheus, grafana, alertmanager, pushgateway
kubectl get pods -n external-secrets      # external-secrets operator
kubectl get clustersecretstore            # aws-secretsmanager → Ready
kubectl get pods -n crossplane-system     # crossplane + 5 provider-aws-* pods
kubectl get providers.pkg.crossplane.io   # all five INSTALLED=True HEALTHY=True
kubectl get ingress -n services           # ALB address
```

Visit the ALB hostname:
```json
{"service":"hello-service","version":"<sha>","message":"Hello from the IDP!"}
```

> **Observability note:** `bootstrap.sh` installs the full `kube-prometheus-stack` (Prometheus + Grafana + AlertManager + Pushgateway) on AWS at parity with the local Kind setup. Grafana is pre-configured with the CloudWatch datasource using IRSA — no static AWS credentials needed.
>
> OPA/Gatekeeper enforces all five golden-path policies (`require-health-probes`, `require-resource-limits`, `require-labels`, `deny-latest-tag`, `require-cost-tags`). The bootstrap waits for CRDs to be established before applying constraints rather than sleeping.

### 5. Deploy Backstage to AWS (optional)

```bash
# Build the Backstage backend bundle first
cd backstage/app && yarn install && yarn build:backend && cd ../..

# Build and push the production image
docker build -t <ECR_URI>/backstage:latest ./backstage
docker push <ECR_URI>/backstage:latest

# Deploy (Kubernetes manifests TBD)
```

## Adding AWS CD to a Scaffolded Service

Scaffolded service repos ship with CI only (`test` job). To add AWS deployment:

1. Add the four secrets above to the GitHub repo
2. Add a `deploy` job to `.github/workflows/build-and-deploy.yml`:

```yaml
deploy:
  needs: test
  runs-on: ubuntu-latest
  if: github.ref == 'refs/heads/main' && github.event_name == 'push'
  steps:
    - uses: actions/checkout@v4

    - name: Configure AWS credentials
      uses: aws-actions/configure-aws-credentials@v4
      with:
        role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
        aws-region: ${{ secrets.AWS_REGION }}

    - name: Log in to ECR
      uses: aws-actions/amazon-ecr-login@v2

    - name: Build and push image
      env:
        REGISTRY: ${{ secrets.ECR_REGISTRY }}
        IMAGE_TAG: ${{ github.sha }}
      run: |
        docker build -t $REGISTRY/${{ env.SERVICE_NAME }}:$IMAGE_TAG .
        docker push $REGISTRY/${{ env.SERVICE_NAME }}:$IMAGE_TAG

    - name: Update kubeconfig
      run: aws eks update-kubeconfig --region ${{ secrets.AWS_REGION }} --name ${{ secrets.EKS_CLUSTER }}

    - name: Deploy via Helm
      env:
        REGISTRY: ${{ secrets.ECR_REGISTRY }}
      run: |
        helm upgrade --install ${{ env.SERVICE_NAME }} \
          oci://$REGISTRY/helm/service-template \
          --namespace services --create-namespace \
          --set image.repository=$REGISTRY/${{ env.SERVICE_NAME }} \
          --set image.tag=${{ github.sha }} \
          --values helm-values.yaml \
          --wait --timeout 120s
```

## Teardown

```bash
# Remove all deployed services first
helm uninstall hello-service -n services
helm uninstall grafana -n monitoring

# Destroy infrastructure
cd terraform && terraform destroy
```
