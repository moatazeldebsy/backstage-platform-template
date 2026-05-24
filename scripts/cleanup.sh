#!/usr/bin/env bash
# cleanup.sh — Clean up all AWS resources safely
# Usage: ./scripts/cleanup.sh [--region us-east-1] [--cluster-name idp-mvp] [--force]
set -euo pipefail

# ── Defaults ─────────────────────────────────────────────────────────────────
AWS_REGION="${AWS_REGION:-us-east-1}"
CLUSTER_NAME="${CLUSTER_NAME:-idp-mvp}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TF_DIR="${ROOT_DIR}/terraform"
FORCE="${FORCE:-false}"

log()  { echo "[$(date +%T)] INFO  $*"; }
warn() { echo "[$(date +%T)] WARN  $*" >&2; }
err()  { echo "[$(date +%T)] ERROR $*" >&2; exit 1; }

# ── Parse flags ───────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --region)        AWS_REGION="$2"; shift 2 ;;
    --cluster-name)  CLUSTER_NAME="$2"; shift 2 ;;
    --force)         FORCE=true; shift ;;
    *) err "Unknown flag: $1" ;;
  esac
done

# ── Confirmation ──────────────────────────────────────────────────────────────
if [[ "$FORCE" != "true" ]]; then
  warn "This will DELETE all AWS resources for cluster: $CLUSTER_NAME"
  read -p "Are you sure? Type 'yes' to confirm: " confirm
  [[ "$confirm" == "yes" ]] || err "Cancelled"
fi

log "Starting cleanup for cluster=$CLUSTER_NAME, region=$AWS_REGION"

# ── Phase 1: Delete Load Balancers created by Kubernetes services ─────────────
log "Phase 1: Cleaning up Load Balancers..."

ALB_COUNT=$(aws elbv2 describe-load-balancers \
  --region "${AWS_REGION}" \
  --query "LoadBalancers[?contains(LoadBalancerName, 'k8s-')].LoadBalancerArn" \
  --output text | wc -w)

if [[ $ALB_COUNT -gt 0 ]]; then
  log "  Found $ALB_COUNT Kubernetes-managed load balancers"
  aws elbv2 describe-load-balancers \
    --region "${AWS_REGION}" \
    --query "LoadBalancers[?contains(LoadBalancerName, 'k8s-')].LoadBalancerArn" \
    --output text | tr '\t' '\n' | while read -r arn; do
    [[ -n "$arn" ]] && {
      log "  Deleting ALB: $arn"
      aws elbv2 delete-load-balancer --load-balancer-arn "$arn" --region "${AWS_REGION}" 2>/dev/null || true
    }
  done
  log "  Waiting for ALBs to be deleted..."
  sleep 15
else
  log "  No Kubernetes load balancers found"
fi

# ── Phase 2: Disable RDS deletion protection ──────────────────────────────────
log "Phase 2: Disabling RDS deletion protection..."

RDS_INSTANCE="${CLUSTER_NAME}-backstage"
if aws rds describe-db-instances \
  --db-instance-identifier "$RDS_INSTANCE" \
  --region "${AWS_REGION}" \
  --query 'DBInstances[0].DBInstanceIdentifier' \
  --output text &>/dev/null 2>&1; then

  log "  Disabling deletion protection for $RDS_INSTANCE"
  aws rds modify-db-instance \
    --db-instance-identifier "$RDS_INSTANCE" \
    --no-deletion-protection \
    --apply-immediately \
    --region "${AWS_REGION}" 2>/dev/null || true
else
  log "  RDS instance not found (already deleted?)"
fi

# ── Phase 3: Terraform destroy ────────────────────────────────────────────────
log "Phase 3: Running terraform destroy..."

cd "$TF_DIR"

# Force unlock if there's a stale lock
log "  Checking for stale Terraform state lock..."
LOCK_ID=$(aws dynamodb scan \
  --table-name "${CLUSTER_NAME}-terraform-locks" \
  --region "${AWS_REGION}" \
  --projection-expression "LockID" \
  --query "Items[0].LockID.S" \
  --output text 2>/dev/null || echo "")

if [[ -n "$LOCK_ID" && "$LOCK_ID" != "None" ]]; then
  log "  Force unlocking stale lock: $LOCK_ID"
  terraform force-unlock "$LOCK_ID" -force || true
fi

# Run terraform destroy
terraform destroy \
  -var "aws_region=${AWS_REGION}" \
  -var "cluster_name=${CLUSTER_NAME}" \
  -auto-approve

log "Phase 3 complete: Terraform resources destroyed"

# ── Phase 4: Verify cleanup ──────────────────────────────────────────────────
log "Phase 4: Verifying cleanup..."

EKS_CLUSTERS=$(aws eks list-clusters --region "${AWS_REGION}" \
  --query "clusters[?contains(@, '${CLUSTER_NAME}')]" --output text | wc -w)

RDS_INSTANCES=$(aws rds describe-db-instances --region "${AWS_REGION}" \
  --query "DBInstances[?contains(DBInstanceIdentifier, '${CLUSTER_NAME}')].DBInstanceIdentifier" \
  --output text | wc -w)

REMAINING_ALBS=$(aws elbv2 describe-load-balancers --region "${AWS_REGION}" \
  --query "LoadBalancers[?contains(LoadBalancerName, 'k8s-')].LoadBalancerArn" \
  --output text | wc -w)

log ""
log "╔════════════════════════════════════════════════════════════════╗"
log "║                    CLEANUP VERIFICATION                       ║"
log "╚════════════════════════════════════════════════════════════════╝"
log "  EKS Clusters remaining: $EKS_CLUSTERS (should be 0)"
log "  RDS Instances remaining: $RDS_INSTANCES (should be 0)"
log "  Load Balancers remaining: $REMAINING_ALBS (should be 0)"

if [[ $EKS_CLUSTERS -eq 0 && $RDS_INSTANCES -eq 0 && $REMAINING_ALBS -eq 0 ]]; then
  log ""
  log "✅ CLEANUP COMPLETE — All AWS resources destroyed"
  log ""
  log "Remaining (preserved for future use):"
  log "  • S3 Terraform state bucket: ${CLUSTER_NAME}-terraform-state-*"
  log "  • Local code and configurations"
else
  warn ""
  warn "⚠️  Some resources may not have been cleaned up"
  warn "  Run again with --force to retry, or manually:"
  if [[ $REMAINING_ALBS -gt 0 ]]; then
    warn "  aws elbv2 delete-load-balancer (for remaining ALBs)"
  fi
  if [[ $RDS_INSTANCES -gt 0 ]]; then
    warn "  aws rds delete-db-instance --skip-final-snapshot (for RDS)"
  fi
  if [[ $EKS_CLUSTERS -gt 0 ]]; then
    warn "  terraform destroy -auto-approve (for EKS)"
  fi
fi
