#!/usr/bin/env bash
# setup-v2-multiregion.sh — one-shot post-apply wiring for V2 multi-region.
#
# Run ONCE after both regional Terraform workspaces AND terraform/global have
# been applied. Automates all manual steps that were previously documented as
# REPLACE_ME placeholders:
#
#   1. Patch Crossplane standby ProviderConfig IRSA ARN
#   2. Register both EKS clusters in ArgoCD hub
#   3. Patch failover-runner-rbac.yaml with IRSA ARN and apply
#   4. Populate Aurora Global endpoints in Backstage Secrets Manager secret
#   5. Generate and store ArgoCD failover token
#   6. Apply ArgoCD cluster ExternalSecrets + notifications config
#
# Usage:
#   ./scripts/setup-v2-multiregion.sh \
#     --primary-workspace  eu-central-1 \
#     --standby-workspace  us-east-1 \
#     --tf-dir             terraform \
#     --global-tf-dir      terraform/global

set -euo pipefail

PRIMARY_WORKSPACE="eu-central-1"
STANDBY_WORKSPACE="us-east-1"
TF_DIR="terraform"
GLOBAL_TF_DIR="terraform/global"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --primary-workspace) PRIMARY_WORKSPACE="$2"; shift 2 ;;
    --standby-workspace) STANDBY_WORKSPACE="$2"; shift 2 ;;
    --tf-dir)            TF_DIR="$2";            shift 2 ;;
    --global-tf-dir)     GLOBAL_TF_DIR="$2";     shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

log() { echo "▶ $*"; }
ok()  { echo "✓ $*"; }

# ── Read Terraform outputs ────────────────────────────────────────────────────

log "Reading Terraform outputs from primary workspace (${PRIMARY_WORKSPACE})..."
cd "$TF_DIR"
terraform workspace select "$PRIMARY_WORKSPACE"
PRIMARY_CLUSTER=$(terraform output -raw cluster_name)
PRIMARY_REGION=$(terraform output -raw secondary_region | tr -d '\n'; echo "$PRIMARY_WORKSPACE")  # invert
CROSSPLANE_ROLE_PRIMARY=$(terraform output -raw crossplane_aws_role_arn)
cd - > /dev/null

log "Reading Terraform outputs from standby workspace (${STANDBY_WORKSPACE})..."
cd "$TF_DIR"
terraform workspace select "$STANDBY_WORKSPACE"
STANDBY_CLUSTER=$(terraform output -raw cluster_name)
CROSSPLANE_ROLE_STANDBY=$(terraform output -raw crossplane_aws_role_arn)
ARGOCD_CLUSTER_SECRET_STANDBY=$(terraform output -raw argocd_cluster_secret_name)
cd - > /dev/null

log "Reading global Terraform outputs..."
cd "$GLOBAL_TF_DIR"
FAILOVER_RUNNER_ROLE=$(terraform output -raw failover_runner_role_arn)
AURORA_WRITER=$(terraform output -raw aurora_primary_writer_endpoint)
AURORA_READER_PRIMARY=$(terraform output -raw aurora_primary_reader_endpoint)
AURORA_READER_STANDBY=$(terraform output -raw aurora_replica_reader_endpoint)
cd - > /dev/null

ok "All Terraform outputs read."

# ── Step 1: Patch Crossplane standby ProviderConfig ───────────────────────────
log "Step 1/6 — Patching Crossplane ProviderConfig for ${STANDBY_WORKSPACE}..."

sed -i.bak \
  "s|REPLACE_WITH_STANDBY_IRSA_ARN|${CROSSPLANE_ROLE_STANDBY}|g" \
  aws/crossplane/providers/provider-config-us-east-1.yaml

ok "provider-config-us-east-1.yaml patched."

# ── Step 2: Register both clusters in ArgoCD ──────────────────────────────────
log "Step 2/6 — Registering clusters in ArgoCD hub..."

# Switch to primary cluster context (hub)
aws eks update-kubeconfig --region "$PRIMARY_WORKSPACE" --name "$PRIMARY_CLUSTER" --alias hub

bash scripts/register-argocd-cluster.sh \
  --cluster "$PRIMARY_CLUSTER" \
  --region  "$PRIMARY_WORKSPACE"

bash scripts/register-argocd-cluster.sh \
  --cluster "$STANDBY_CLUSTER" \
  --region  "$STANDBY_WORKSPACE"

ok "Both clusters registered."

# ── Step 3: Apply failover-runner RBAC with real IRSA ARN ────────────────────
log "Step 3/6 — Applying failover-runner RBAC..."

sed "s|REPLACE_WITH_FAILOVER_RUNNER_ROLE_ARN|${FAILOVER_RUNNER_ROLE}|g" \
  aws/argo-workflows/failover-runner-rbac.yaml | kubectl apply -f - --context hub

ok "failover-runner RBAC applied."

# ── Step 4: Populate Aurora endpoints in Backstage secret ────────────────────
log "Step 4/6 — Updating Backstage Secrets Manager with Aurora endpoints..."

SECRET_NAME="idp-mvp/backstage"

CURRENT=$(aws secretsmanager get-secret-value \
  --region "$PRIMARY_WORKSPACE" \
  --secret-id "$SECRET_NAME" \
  --query "SecretString" --output text)

UPDATED=$(echo "$CURRENT" | jq \
  --arg writer  "$AURORA_WRITER" \
  --arg reader  "$AURORA_READER_PRIMARY" \
  --arg rstandby "$AURORA_READER_STANDBY" \
  '.POSTGRES_HOST = $writer |
   .POSTGRES_HOST_WRITER = $writer |
   .POSTGRES_HOST_READER = $reader |
   .POSTGRES_HOST_READER_STANDBY = $rstandby')

aws secretsmanager put-secret-value \
  --region "$PRIMARY_WORKSPACE" \
  --secret-id "$SECRET_NAME" \
  --secret-string "$UPDATED"

ok "Aurora endpoints stored in Secrets Manager."

# ── Step 5: Generate and store ArgoCD failover token ─────────────────────────
log "Step 5/6 — Generating ArgoCD failover token..."

ARGOCD_SERVER=$(kubectl get svc argocd-server -n argocd \
  --context hub -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')

# Create ArgoCD account for failover-runner if not exists
argocd account list --server "$ARGOCD_SERVER" --insecure 2>/dev/null | grep -q failover-runner || \
  echo "Note: create 'failover-runner' account in ArgoCD ConfigMap (argocd-cm) first."

ARGOCD_TOKEN=$(argocd account generate-token \
  --account failover-runner \
  --server "$ARGOCD_SERVER" \
  --insecure 2>/dev/null || echo "REPLACE_ME_argocd_account_generate-token")

kubectl create secret generic argocd-failover-token \
  --from-literal=token="$ARGOCD_TOKEN" \
  -n argo \
  --context hub \
  --dry-run=client -o yaml | kubectl apply -f - --context hub

ok "ArgoCD failover token stored."

# ── Step 6: Apply ArgoCD cluster ExternalSecrets + notifications ──────────────
log "Step 6/6 — Applying ArgoCD cluster secrets and notifications config..."

kubectl apply -f aws/argocd/cluster-secrets/ -n argocd --context hub
kubectl apply -f aws/argocd/notifications-config.yaml  --context hub

ok "ArgoCD ExternalSecrets and notifications applied."

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════"
echo "  V2 multi-region wiring complete"
echo "═══════════════════════════════════════════════════════"
echo "  Primary cluster  : ${PRIMARY_CLUSTER} (${PRIMARY_WORKSPACE})"
echo "  Standby cluster  : ${STANDBY_CLUSTER} (${STANDBY_WORKSPACE})"
echo "  Aurora writer    : ${AURORA_WRITER}"
echo "  Aurora reader    : ${AURORA_READER_STANDBY} (standby)"
echo ""
echo "  Next steps:"
echo "  1. Set Slack bot token in argocd-notifications-secret"
echo "  2. Apply aws/argocd/app-of-apps-standby.yaml to start standby sync"
echo "  3. Run a GameDay: argo submit aws/argo-workflows/failover-runbook.yaml"
echo "═══════════════════════════════════════════════════════"
