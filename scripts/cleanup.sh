#!/usr/bin/env bash
# cleanup.sh — Clean up all AWS resources safely
# Usage: ./scripts/cleanup.sh [--region us-east-1] [--cluster-name idp-mvp] [--force]
#
# Destruction order matters:
#   1. ALBs (K8s-managed, block VPC deletion)
#   2. Backstage RDS deletion-protection off
#   3. Crossplane-orphaned resources (idp:provisioner=crossplane tag)
#   4. Empty ECR repos + Terraform-managed S3 buckets (block terraform destroy)
#   5. terraform destroy (EKS, VPC, IAM, RDS-backstage, ECR, etc.)
#   6. CloudWatch log groups (EKS leaves these behind)
#   7. Verify
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
  warn "Including Crossplane-provisioned resources tagged idp:provisioner=crossplane"
  read -p "Are you sure? Type 'yes' to confirm: " confirm
  [[ "$confirm" == "yes" ]] || err "Cancelled"
fi

log "Starting cleanup for cluster=$CLUSTER_NAME, region=$AWS_REGION"

# ── Phase 1: Delete Load Balancers created by Kubernetes services ─────────────
log "Phase 1: Cleaning up Load Balancers..."

# ALBs/NLBs (v2) — created by aws-load-balancer-controller, prefixed k8s-
ALB_COUNT=$(aws elbv2 describe-load-balancers \
  --region "${AWS_REGION}" \
  --query "length(LoadBalancers[?contains(LoadBalancerName, 'k8s-')])" \
  --output text 2>/dev/null || echo 0)

if [[ $ALB_COUNT -gt 0 ]]; then
  log "  Found $ALB_COUNT ALB/NLB load balancers (k8s-*)"
  aws elbv2 describe-load-balancers \
    --region "${AWS_REGION}" \
    --query "LoadBalancers[?contains(LoadBalancerName, 'k8s-')].LoadBalancerArn" \
    --output text | tr '\t' '\n' | while read -r arn; do
    [[ -n "$arn" ]] && {
      log "  Deleting ALB: $arn"
      aws elbv2 delete-load-balancer --load-balancer-arn "$arn" --region "${AWS_REGION}" 2>/dev/null || true
    }
  done
else
  log "  No ALB/NLB load balancers found"
fi

# Classic ELBs (v1) — created by nginx-ingress on older K8s versions.
# These use the aws elb API and are not caught by elbv2 above.
CLASSIC_COUNT=$(aws elb describe-load-balancers \
  --region "${AWS_REGION}" \
  --query "length(LoadBalancerDescriptions)" \
  --output text 2>/dev/null || echo 0)

if [[ $CLASSIC_COUNT -gt 0 ]]; then
  log "  Found $CLASSIC_COUNT Classic (v1) load balancers — deleting all in this account/region"
  aws elb describe-load-balancers \
    --region "${AWS_REGION}" \
    --query "LoadBalancerDescriptions[*].LoadBalancerName" \
    --output text | tr '\t' '\n' | while read -r name; do
    [[ -n "$name" ]] && {
      log "  Deleting Classic ELB: $name"
      aws elb delete-load-balancer --load-balancer-name "$name" --region "${AWS_REGION}" 2>/dev/null || true
    }
  done
else
  log "  No Classic load balancers found"
fi

if [[ $ALB_COUNT -gt 0 || $CLASSIC_COUNT -gt 0 ]]; then
  log "  Waiting 20s for ENIs to be released after LB deletion..."
  sleep 20
fi

# Stale k8s-managed security groups — EKS does not always clean these up on
# cluster delete, and they block VPC deletion with DependencyViolation.
log "  Cleaning up stale k8s-managed security groups..."
VPC_ID=$(aws ec2 describe-vpcs --region "${AWS_REGION}" \
  --filters "Name=tag:Name,Values=${CLUSTER_NAME}-vpc" \
  --query 'Vpcs[0].VpcId' --output text 2>/dev/null || echo "")
if [[ -n "$VPC_ID" && "$VPC_ID" != "None" ]]; then
  aws ec2 describe-security-groups --region "${AWS_REGION}" \
    --filters "Name=vpc-id,Values=${VPC_ID}" \
    --query "SecurityGroups[?starts_with(GroupName,'k8s-')].GroupId" \
    --output text | tr '\t' '\n' | while read -r sg; do
    [[ -z "$sg" ]] && continue
    log "    Deleting stale SG: $sg"
    aws ec2 delete-security-group --group-id "$sg" --region "${AWS_REGION}" 2>/dev/null || true
  done
else
  log "  VPC not found by name tag — skipping stale SG cleanup"
fi

# ── Phase 2: Disable RDS deletion protection (Backstage DB) ──────────────────
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

# ── Phase 3: Crossplane-orphaned resources ────────────────────────────────────
# Resources tagged idp:provisioner=crossplane were provisioned by Crossplane
# Claims and are not tracked by Terraform state. deletionPolicy:Orphan means
# they survive Claim deletion, so they must be removed explicitly here.
log "Phase 3: Cleaning up Crossplane-provisioned resources (idp:provisioner=crossplane)..."

_crossplane_arns() {
  local resource_type="$1"
  aws resourcegroupstaggingapi get-resources \
    --region "${AWS_REGION}" \
    --tag-filters "Key=idp:provisioner,Values=crossplane" \
    --resource-type-filters "$resource_type" \
    --query 'ResourceTagMappingList[*].ResourceARN' \
    --output text 2>/dev/null || true
}

# ── 3a: S3 buckets ───────────────────────────────────────────────────────────
log "  3a: Crossplane S3 buckets..."
while IFS= read -r bucket_arn; do
  [[ -z "$bucket_arn" || "$bucket_arn" == "None" ]] && continue
  bucket_name="${bucket_arn##*:::}"
  log "    Emptying and deleting s3://${bucket_name}"
  # Remove all current-version objects
  aws s3 rm "s3://${bucket_name}" --recursive --region "${AWS_REGION}" 2>/dev/null || true
  # Remove all versioned objects and delete markers (versioning-enabled buckets)
  aws s3api list-object-versions \
    --bucket "${bucket_name}" \
    --region "${AWS_REGION}" \
    --query '{Objects: Versions[].{Key:Key,VersionId:VersionId}}' \
    --output json 2>/dev/null \
    | grep -q '"Key"' && \
    aws s3api delete-objects \
      --bucket "${bucket_name}" \
      --region "${AWS_REGION}" \
      --delete "$(aws s3api list-object-versions \
        --bucket "${bucket_name}" \
        --region "${AWS_REGION}" \
        --query '{Objects: Versions[].{Key:Key,VersionId:VersionId}}' \
        --output json)" 2>/dev/null || true
  aws s3api list-object-versions \
    --bucket "${bucket_name}" \
    --region "${AWS_REGION}" \
    --query '{Objects: DeleteMarkers[].{Key:Key,VersionId:VersionId}}' \
    --output json 2>/dev/null \
    | grep -q '"Key"' && \
    aws s3api delete-objects \
      --bucket "${bucket_name}" \
      --region "${AWS_REGION}" \
      --delete "$(aws s3api list-object-versions \
        --bucket "${bucket_name}" \
        --region "${AWS_REGION}" \
        --query '{Objects: DeleteMarkers[].{Key:Key,VersionId:VersionId}}' \
        --output json)" 2>/dev/null || true
  aws s3api delete-bucket --bucket "${bucket_name}" --region "${AWS_REGION}" 2>/dev/null || true
  log "    Deleted: ${bucket_name}"
done < <(_crossplane_arns "s3" | tr '\t' '\n')

# ── 3b: RDS instances ────────────────────────────────────────────────────────
log "  3b: Crossplane RDS instances..."
CROSSPLANE_RDS_IDS=()
while IFS= read -r rds_arn; do
  [[ -z "$rds_arn" || "$rds_arn" == "None" ]] && continue
  # ARN format: arn:aws:rds:<region>:<account>:db:<identifier>
  db_id="${rds_arn##*:db:}"
  log "    Disabling deletion-protection and deleting RDS: ${db_id}"
  aws rds modify-db-instance \
    --db-instance-identifier "${db_id}" \
    --no-deletion-protection \
    --apply-immediately \
    --region "${AWS_REGION}" 2>/dev/null || true
  aws rds delete-db-instance \
    --db-instance-identifier "${db_id}" \
    --skip-final-snapshot \
    --delete-automated-backups \
    --region "${AWS_REGION}" 2>/dev/null || true
  CROSSPLANE_RDS_IDS+=("${db_id}")
  log "    Deletion initiated: ${db_id} (takes 5-10 min in background)"
done < <(_crossplane_arns "rds:db" | tr '\t' '\n')

# ── 3c: DynamoDB tables ──────────────────────────────────────────────────────
log "  3c: Crossplane DynamoDB tables..."
while IFS= read -r dynamo_arn; do
  [[ -z "$dynamo_arn" || "$dynamo_arn" == "None" ]] && continue
  table_name="${dynamo_arn##*/}"
  log "    Deleting DynamoDB table: ${table_name}"
  aws dynamodb delete-table \
    --table-name "${table_name}" \
    --region "${AWS_REGION}" 2>/dev/null || true
  log "    Deleted: ${table_name}"
done < <(_crossplane_arns "dynamodb:table" | tr '\t' '\n')

# ── 3d: SQS queues ───────────────────────────────────────────────────────────
log "  3d: Crossplane SQS queues..."
while IFS= read -r sqs_arn; do
  [[ -z "$sqs_arn" || "$sqs_arn" == "None" ]] && continue
  # ARN format: arn:aws:sqs:<region>:<account>:<queue-name>
  account_id=$(echo "$sqs_arn" | cut -d: -f5)
  queue_name="${sqs_arn##*:}"
  queue_url="https://sqs.${AWS_REGION}.amazonaws.com/${account_id}/${queue_name}"
  log "    Deleting SQS queue: ${queue_name}"
  aws sqs delete-queue \
    --queue-url "${queue_url}" \
    --region "${AWS_REGION}" 2>/dev/null || true
  log "    Deleted: ${queue_name}"
done < <(_crossplane_arns "sqs" | tr '\t' '\n')

# Note: MSK Kafka topics are Kafka-native (not AWS resources) and are destroyed
# automatically when the MSK cluster is deleted by terraform destroy below.

log "  Phase 3 complete."

# ── Phase 4: Empty Terraform-managed S3 buckets + ECR repos ──────────────────
# terraform destroy fails if S3 buckets have objects or ECR repos have images.
log "Phase 4: Emptying S3 buckets and ECR repos before Terraform destroy..."

# ── 4a: S3 buckets owned by Terraform (TechDocs, MLflow artifacts) ───────────
log "  4a: Emptying Terraform-managed S3 buckets..."
TF_BUCKETS=$(aws s3 ls 2>/dev/null \
  | awk '{print $3}' \
  | grep -E "^${CLUSTER_NAME}-" || true)

_empty_versioned_bucket() {
  local bucket="$1"
  local total=0
  # Loop: delete up to 500 versions+markers per iteration until bucket is empty.
  # aws s3 rm --recursive only removes current-version objects; it silently
  # ignores non-current versions and delete markers in versioned buckets.
  while true; do
    local payload
    payload=$(aws s3api list-object-versions --bucket "$bucket" \
      --region "${AWS_REGION}" --output json 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin)
objs=[{'Key':v['Key'],'VersionId':v['VersionId']} for v in d.get('Versions',[])[:500]]
objs+=[{'Key':m['Key'],'VersionId':m['VersionId']} for m in d.get('DeleteMarkers',[])[:500]]
print(json.dumps({'Objects':objs,'Quiet':True}) if objs else '')
" 2>/dev/null)
    [[ -z "$payload" ]] && break
    aws s3api delete-objects --bucket "$bucket" --region "${AWS_REGION}" \
      --delete "$payload" >/dev/null 2>&1
    local count
    count=$(echo "$payload" | python3 -c "import json,sys; print(len(json.load(sys.stdin).get('Objects',[])))" 2>/dev/null || echo 0)
    total=$((total + count))
  done
  log "    Deleted $total versioned objects from s3://${bucket}"
}

while IFS= read -r bucket; do
  [[ -z "$bucket" ]] && continue
  # Skip the Terraform state bucket — it must be preserved
  [[ "$bucket" == *"-terraform-state"* ]] && {
    log "    Skipping state bucket: ${bucket}"
    continue
  }
  log "    Emptying s3://${bucket}"
  _empty_versioned_bucket "${bucket}"
done <<< "$TF_BUCKETS"

# ── 4b: ECR repositories ─────────────────────────────────────────────────────
# Match both flat names (idp-mvp-foo) and nested paths (idp-mvp/foo) since
# bootstrap-ai.sh creates repos under ${CLUSTER_NAME}/<service> path.
log "  4b: Deleting ECR repositories..."
ECR_REPOS=$(aws ecr describe-repositories \
  --region "${AWS_REGION}" \
  --query "repositories[?contains(repositoryName, '${CLUSTER_NAME}')].repositoryName" \
  --output text 2>/dev/null || true)

while IFS= read -r repo; do
  [[ -z "$repo" || "$repo" == "None" ]] && continue
  log "    Deleting ECR repo: ${repo}"
  # --force deletes all images and the repo in one call.
  # Repos created by bootstrap-ai.sh (idp-mvp/<svc>) are not in Terraform
  # state, so they must be deleted explicitly here rather than by terraform destroy.
  aws ecr delete-repository \
    --repository-name "${repo}" \
    --region "${AWS_REGION}" \
    --force 2>/dev/null && log "    Deleted: ${repo}" || log "    Already gone: ${repo}"
done <<< "$ECR_REPOS"

log "  Phase 4 complete."

# ── Phase 5: Terraform destroy ────────────────────────────────────────────────
log "Phase 5: Running terraform destroy..."

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

terraform destroy \
  -var "aws_region=${AWS_REGION}" \
  -var "cluster_name=${CLUSTER_NAME}" \
  -auto-approve

log "Phase 5 complete: Terraform resources destroyed"

# ── Phase 6: CloudWatch log groups ───────────────────────────────────────────
# EKS creates /aws/eks/<cluster>/cluster and /aws/containerinsights/<cluster>/*
# log groups that persist after the cluster is deleted and accumulate cost.
log "Phase 6: Deleting CloudWatch log groups..."

LOG_PREFIXES=(
  "/aws/eks/${CLUSTER_NAME}"
  "/aws/containerinsights/${CLUSTER_NAME}"
)

for prefix in "${LOG_PREFIXES[@]}"; do
  LOG_GROUPS=$(aws logs describe-log-groups \
    --region "${AWS_REGION}" \
    --log-group-name-prefix "${prefix}" \
    --query 'logGroups[*].logGroupName' \
    --output text 2>/dev/null || true)
  while IFS= read -r lg; do
    [[ -z "$lg" || "$lg" == "None" ]] && continue
    log "  Deleting log group: ${lg}"
    aws logs delete-log-group \
      --log-group-name "${lg}" \
      --region "${AWS_REGION}" 2>/dev/null || true
  done <<< "$LOG_GROUPS"
done

log "  Phase 6 complete."

# ── Phase 7: Verify cleanup ───────────────────────────────────────────────────
log "Phase 7: Verifying cleanup..."

EKS_CLUSTERS=$(aws eks list-clusters --region "${AWS_REGION}" \
  --query "clusters[?contains(@, '${CLUSTER_NAME}')]" --output text | wc -w)

RDS_INSTANCES=$(aws rds describe-db-instances --region "${AWS_REGION}" \
  --query "DBInstances[?contains(DBInstanceIdentifier, '${CLUSTER_NAME}')].DBInstanceIdentifier" \
  --output text | wc -w)

REMAINING_ALBS=$(aws elbv2 describe-load-balancers --region "${AWS_REGION}" \
  --query "LoadBalancers[?contains(LoadBalancerName, 'k8s-')].LoadBalancerArn" \
  --output text | wc -w)

CROSSPLANE_REMAINING=$(aws resourcegroupstaggingapi get-resources \
  --region "${AWS_REGION}" \
  --tag-filters "Key=idp:provisioner,Values=crossplane" \
  --query 'length(ResourceTagMappingList)' \
  --output text 2>/dev/null || echo "0")

REMAINING_LOG_GROUPS=$(aws logs describe-log-groups \
  --region "${AWS_REGION}" \
  --log-group-name-prefix "/aws/eks/${CLUSTER_NAME}" \
  --query 'length(logGroups)' \
  --output text 2>/dev/null || echo "0")

log ""
log "╔════════════════════════════════════════════════════════════════╗"
log "║                    CLEANUP VERIFICATION                       ║"
log "╚════════════════════════════════════════════════════════════════╝"
log "  EKS Clusters remaining:             $EKS_CLUSTERS (should be 0)"
log "  RDS Instances remaining:            $RDS_INSTANCES (should be 0)"
log "  Load Balancers remaining:           $REMAINING_ALBS (should be 0)"
log "  Crossplane resources remaining:     $CROSSPLANE_REMAINING (should be 0)"
log "  CloudWatch log groups remaining:    $REMAINING_LOG_GROUPS (should be 0)"

CLEAN=true
[[ $EKS_CLUSTERS -gt 0 ]]        && CLEAN=false
[[ $RDS_INSTANCES -gt 0 ]]       && CLEAN=false
[[ $REMAINING_ALBS -gt 0 ]]      && CLEAN=false
[[ "$CROSSPLANE_REMAINING" -gt 0 ]] && CLEAN=false

if $CLEAN; then
  log ""
  log "✅ CLEANUP COMPLETE — All AWS resources destroyed"
  log ""
  log "Preserved (intentional):"
  log "  • S3 Terraform state bucket: ${CLUSTER_NAME}-terraform-state-*"
  log "  • Local code and configurations"
  if [[ "${#CROSSPLANE_RDS_IDS[@]}" -gt 0 ]]; then
    log ""
    log "Note: Crossplane RDS deletions are async and may still be in progress."
    log "Verify with: aws rds describe-db-instances --region ${AWS_REGION}"
  fi
else
  warn ""
  warn "⚠️  Some resources may not have been cleaned up"
  warn "  Run again with --force to retry, or manually:"
  [[ $REMAINING_ALBS -gt 0 ]] && \
    warn "  aws elbv2 delete-load-balancer (for remaining ALBs)"
  [[ $RDS_INSTANCES -gt 0 ]] && \
    warn "  aws rds delete-db-instance --skip-final-snapshot (for RDS)"
  [[ $EKS_CLUSTERS -gt 0 ]] && \
    warn "  terraform destroy -auto-approve (for EKS)"
  [[ "$CROSSPLANE_REMAINING" -gt 0 ]] && \
    warn "  aws resourcegroupstaggingapi get-resources --tag-filters Key=idp:provisioner,Values=crossplane (list remaining)"
fi
