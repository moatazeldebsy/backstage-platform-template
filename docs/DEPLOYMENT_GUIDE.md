# AWS Deployment Guide — Complete Checklist

**Last Updated**: 2026-05-23  
**Status**: Production-Ready with Known Issues & Workarounds

---

## Table of Contents

1. [Pre-Deployment Checklist](#pre-deployment-checklist)
2. [Deployment Steps](#deployment-steps)
3. [Known Issues & Workarounds](#known-issues--workarounds)
4. [Post-Deployment Validation](#post-deployment-validation)
5. [Troubleshooting](#troubleshooting)
6. [Production Hardening](#production-hardening)

---

## Pre-Deployment Checklist

### Prerequisites (One-Time)

- [ ] AWS Account with sufficient permissions (EC2, EKS, RDS, S3, IAM, Secrets Manager)
- [ ] AWS CLI ≥ 2.15 installed and configured
- [ ] Terraform ≥ 1.5 installed
- [ ] kubectl installed
- [ ] Helm ≥ 3.x installed
- [ ] Docker running (for local testing)
- [ ] GitHub CLI (`gh`) installed and authenticated
- [ ] GitHub organization set up (for OIDC trust relationship)
- [ ] Anthropic API key obtained (optional, for AI/ML features)

### Environment Setup

```bash
# Set environment variables
export AWS_REGION="us-east-1"
export CLUSTER_NAME="idp-mvp"
export GITHUB_ORG="your-github-org"
export ANTHROPIC_API_KEY="your-api-key"  # Optional

# Verify credentials
aws sts get-caller-identity
aws ec2 describe-availability-zones --region $AWS_REGION
```

### S3 Terraform State Bucket (Must Exist Before Deployment)

```bash
# Create S3 bucket for Terraform state
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
BUCKET_NAME="idp-mvp-terraform-state-${ACCOUNT_ID}"

aws s3api create-bucket \
  --bucket "$BUCKET_NAME" \
  --region $AWS_REGION

# Enable versioning
aws s3api put-bucket-versioning \
  --bucket "$BUCKET_NAME" \
  --versioning-configuration Status=Enabled

# Enable encryption
aws s3api put-bucket-encryption \
  --bucket "$BUCKET_NAME" \
  --server-side-encryption-configuration '{
    "Rules": [{
      "ApplyServerSideEncryptionByDefault": {
        "SSEAlgorithm": "AES256"
      }
    }]
  }'

# Create DynamoDB lock table
aws dynamodb create-table \
  --table-name "${CLUSTER_NAME}-terraform-locks" \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region $AWS_REGION
```

---

## Deployment Steps

### Step 1: Personalize Configuration

```bash
./scripts/setup.sh
```

**What it does:**
- Replaces `YOUR_*` placeholders with actual values
- Creates `.idp-config.env` with cluster configuration
- Generates `terraform.tfvars`

**Review files:**
- `terraform/terraform.tfvars` — set `github_org`, `anthropic_api_key`, etc.
- `local/.env` — verify AWS region and cluster name

### Step 2: Bootstrap AWS Infrastructure

```bash
./scripts/bootstrap.sh
```

**Deployment timeline:**
- Phase 1 (Terraform): 15-25 minutes
  - VPC, EKS cluster (2 nodes), RDS, ECR, IAM
  - External Secrets Operator (waits for pods)
  - Secrets Manager integration
- Phase 2-4 (Platform): 10-15 minutes
  - Prometheus, Grafana, Loki
  - ArgoCD, OPA/Gatekeeper
  - Application deployments
- Phase 5 (Backstage): 5 minutes
  - Download and deploy official image

**Total time: ~45-60 minutes**

### Step 3: Optional — Deploy AI/ML Stack

```bash
# Requires ANTHROPIC_API_KEY in environment
./scripts/bootstrap-ai.sh
```

**Deploys:**
- MLflow tracking server (S3 artifact backend)
- KAgent v0.9.4 (with PostgreSQL database)
- 12 pre-configured agents
- idp-assistant (Backstage integration)

---

## Known Issues & Workarounds

### ⚠️ Issue 1: Backstage Port Configuration

**Symptom:** Backstage responds with 502 Bad Gateway on port 3000

**Root Cause:** Official `ghcr.io/backstage/backstage:latest` image ignores `listen.port` config and uses hardcoded port 7007

**Solution:**
```bash
# Service automatically configures for port 7007
# No action needed — already fixed in bootstrap.sh

# Verify:
kubectl get service backstage -n backstage -o jsonpath='{.spec.ports[*].targetPort}'
# Should output: 7007
```

---

### ⚠️ Issue 2: RDS Deletion Protection Blocks Cleanup

**Symptom:** `terraform destroy` fails with "Cannot delete protected DB Instance"

**Root Cause:** RDS deletion protection enabled by default in `rds.tf`

**Solution:** Already fixed — `rds.tf` now conditionally disables protection for dev/test environments:
```hcl
deletion_protection = var.environment == "prod" ? true : false
skip_final_snapshot = var.environment == "prod" ? false : true
```

For **production** deployments, set `environment="prod"` in `terraform.tfvars`:
```hcl
environment = "prod"
```

---

### ⚠️ Issue 3: External Secrets Operator Timing

**Symptom:** ClusterSecretStore creation fails because ESO pods aren't ready

**Root Cause:** Bootstrap tried to apply manifests before External Secrets Operator pods reached Running state

**Solution:** Fixed in `bootstrap.sh` — adds explicit wait:
```bash
kubectl wait --for=condition=ready pod \
  -l app.kubernetes.io/name=external-secrets \
  -n external-secrets \
  --timeout=300s
```

---

### ⚠️ Issue 4: Load Balancers Not Cleaned Up

**Symptom:** After `terraform destroy`, 9 ALBs remain (Backstage, ArgoCD, Grafana, MLflow, KAgent, Prometheus, AlertManager, services)

**Root Cause:** Kubernetes services create ALBs dynamically; Terraform doesn't track them as dependencies

**Solution:** Use new cleanup script:
```bash
./scripts/cleanup.sh --cluster-name idp-mvp --force
```

The cleanup script:
1. Deletes all `k8s-*` load balancers first
2. Waits 15 seconds for ALBs to detach from EKS
3. Runs terraform destroy
4. Verifies all resources are gone

---

## Post-Deployment Validation

### Check All Services Are Running

```bash
# Wait for all pods to be Ready
kubectl get pods -A | grep -v Running

# Should show 0 rows (all pods Running)
```

### Verify Access URLs

```bash
# Print all service URLs
./scripts/bootstrap.sh --print-urls

# Example output:
# Backstage: http://k8s-backstag-*.elb.us-east-1.amazonaws.com
# Grafana: http://k8s-monitori-*.elb.us-east-1.amazonaws.com
# ArgoCD: http://k8s-argocd-*.elb.us-east-1.amazonaws.com
```

### Test Backstage Portal

```bash
BACKSTAGE_URL=$(kubectl get service backstage -n backstage -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')

# Should return HTTP 200 with HTML content
curl -I http://$BACKSTAGE_URL/

# Verify database connected
curl -s http://$BACKSTAGE_URL/api/health | jq .
```

### Verify AI/ML Stack (If Deployed)

```bash
# Check KAgent agents status
kubectl get agents -n kagent

# Expected: All agents should show READY=True

# Test MLflow
kubectl get ingress -n ml-platform
curl -I http://<mlflow-alb-url>/

# Test idp-assistant agent
curl -X POST http://<idp-assistant-url>/a2a/idp-assistant \
  -H "Content-Type: application/json" \
  -d '{"method":"tools/list","jsonrpc":"2.0","id":1}'
```

---

## Troubleshooting

### Backstage Not Responding (502 Bad Gateway)

```bash
# Check pod status
kubectl get pods -n backstage
kubectl logs -n backstage deployment/backstage --tail=50

# Common issues:
# 1. Database not connected → check POSTGRES_* env vars
# 2. Config file not mounted → verify ConfigMap
# 3. Port mismatch → should be 7007, not 3000

# Force restart
kubectl rollout restart deployment/backstage -n backstage
```

### Stale Terraform Lock

```bash
# During bootstrap.sh, if it hangs on Terraform apply:
terraform force-unlock <lock-id>
terraform apply -var "cluster_name=idp-mvp" -auto-approve
```

### EKS Nodes Not Ready

```bash
# Check node status
kubectl get nodes
kubectl describe nodes

# Common causes:
# - Insufficient quota in AWS account (need 4× t3.medium)
# - Insufficient IAM permissions
# - VPC or subnet issues

# Wait for nodes to become Ready (5-10 minutes after creation)
kubectl wait --for=condition=Ready node --all --timeout=600s
```

### Load Balancer Stuck in Provisioning

```bash
# ALBs take 3-5 minutes to provision
# Check status
aws elbv2 describe-load-balancers \
  --query 'LoadBalancers[?contains(LoadBalancerName, `backstag`)]'

# If stuck, manually delete and redeploy service
kubectl delete service backstage -n backstage
kubectl apply -f kubernetes/backstage/service.yaml
```

---

## Production Hardening

### 1. Enable RDS Encryption & Backups

```hcl
# In terraform/terraform.tfvars
environment = "prod"

# Enables:
# - Deletion protection
# - Final snapshot before deletion (7 days retention)
# - Storage encryption (AES256)
# - Backup retention = 7 days
```

### 2. Configure AWS Budgets Alert

```bash
# Set email for budget alerts
aws budgets create-budget \
  --account-id $(aws sts get-caller-identity --query Account --output text) \
  --budget file://budget.json \
  --notifications-with-subscribers file://notifications.json
```

Budget limits: $300/month (adjust for your team size)

### 3. Enable CloudWatch Alarms

```bash
# CPU utilization > 80%
aws cloudwatch put-metric-alarm \
  --alarm-name idp-high-cpu \
  --alarm-description "Alert when cluster CPU > 80%" \
  --metric-name CPUUtilization \
  --namespace AWS/ECS \
  --statistic Average \
  --period 300 \
  --threshold 80 \
  --comparison-operator GreaterThanThreshold
```

### 4. Enable RDS Automated Backups

```bash
# Already configured in terraform/rds.tf
backup_retention_period = 7  # Production should use ≥ 30
```

### 5. Rotate API Keys Monthly

```bash
# Update ANTHROPIC_API_KEY
aws secretsmanager update-secret \
  --secret-id idp-mvp/kagent \
  --secret-string '{"ANTHROPIC_API_KEY":"new-key"}'

# Restart KAgent to pick up new key
kubectl rollout restart deployment/kagent-controller -n kagent
```

### 6. Scale EKS for Production Load

Current configuration: 4× t3.medium nodes (sufficient for dev/test)

**For production:**
```hcl
# In terraform/terraform.tfvars
node_instance_types    = ["t3.large"]      # Larger instances
node_group_min_size    = 4
node_group_max_size    = 12
enable_autoscaling     = true
```

### 7. Enable Pod Disruption Budgets

```bash
# Prevent simultaneous pod termination during node updates
kubectl apply -f - <<EOF
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: backstage-pdb
  namespace: backstage
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: backstage
EOF
```

---

## Cleanup & Destroy

**Important:** Save any critical data from S3 buckets before destroying.

```bash
# Safe cleanup with verification
./scripts/cleanup.sh --cluster-name idp-mvp

# What gets deleted:
# ✓ EKS cluster (4 nodes)
# ✓ RDS database
# ✓ VPC & networking
# ✓ All load balancers
# ✓ ECR images (except those tagged as keep)

# What's preserved:
# - S3 Terraform state bucket
# - Local code & configs
# - CloudWatch logs (30-day retention)
```

---

## Support & Escalation

### Common Commands

```bash
# Get cluster info
kubectl cluster-info
kubectl get nodes
kubectl top nodes

# View all deployments
kubectl get deployments -A

# View recent errors
kubectl get events -A --sort-by='.lastTimestamp'

# Check Terraform state
terraform state list
terraform state show aws_eks_cluster.this

# View resource costs
aws ce get-cost-and-usage \
  --time-period Start=2026-05-01,End=2026-05-31 \
  --granularity MONTHLY \
  --metrics BlendedCost
```

### Documentation Links

- [Backstage Admin Guide](https://backstage.io/docs/overview/what-is-backstage)
- [EKS Best Practices](https://aws.github.io/aws-eks-best-practices/)
- [KAgent Documentation](https://www.kagentai.io)
- [MLflow Model Registry](https://mlflow.org/docs/latest/model-registry.html)

---

**Next Steps:**
1. Run pre-deployment checklist
2. Execute `./scripts/setup.sh`
3. Execute `./scripts/bootstrap.sh`
4. Run validation tests
5. Configure production settings
6. Invite team members to Backstage
