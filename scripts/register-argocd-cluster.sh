#!/usr/bin/env bash
# register-argocd-cluster.sh — Post-apply step for hub-spoke ArgoCD setup.
#
# Creates an argocd-manager service account on the TARGET cluster, generates a
# long-lived token, and writes it to Secrets Manager so the ExternalSecret in
# aws/argocd/cluster-secrets/ can create the ArgoCD cluster secret on the HUB.
#
# Usage:
#   # Register the standby cluster (run from the hub context):
#   ./scripts/register-argocd-cluster.sh \
#     --cluster idp-us-east-1 \
#     --region  us-east-1
#
#   # Register the primary cluster (self-registration):
#   ./scripts/register-argocd-cluster.sh \
#     --cluster idp-eu-central-1 \
#     --region  eu-central-1

set -euo pipefail

CLUSTER=""
REGION=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cluster) CLUSTER="$2"; shift 2 ;;
    --region)  REGION="$2";  shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

[[ -z "$CLUSTER" || -z "$REGION" ]] && { echo "Usage: $0 --cluster <name> --region <region>"; exit 1; }

SECRET_NAME="idp-mvp/argocd/cluster-${REGION}"

echo "▶ Updating kubeconfig for ${CLUSTER} (${REGION})..."
aws eks update-kubeconfig --region "$REGION" --name "$CLUSTER"

echo "▶ Creating argocd-manager service account..."
kubectl -n kube-system create serviceaccount argocd-manager --dry-run=client -o yaml | kubectl apply -f -

kubectl create clusterrolebinding argocd-manager \
  --clusterrole=cluster-admin \
  --serviceaccount=kube-system:argocd-manager \
  --dry-run=client -o yaml | kubectl apply -f -

echo "▶ Generating service account token (10-year expiry)..."
TOKEN=$(kubectl -n kube-system create token argocd-manager --duration=87600h)

CA_DATA=$(aws eks describe-cluster \
  --region "$REGION" \
  --name "$CLUSTER" \
  --query "cluster.certificateAuthority.data" \
  --output text)

SERVER=$(aws eks describe-cluster \
  --region "$REGION" \
  --name "$CLUSTER" \
  --query "cluster.endpoint" \
  --output text)

echo "▶ Writing cluster credentials to Secrets Manager (${SECRET_NAME})..."
aws secretsmanager put-secret-value \
  --region eu-central-1 \
  --secret-id "$SECRET_NAME" \
  --secret-string "$(jq -n \
    --arg server "$SERVER" \
    --arg caData "$CA_DATA" \
    --arg bearerToken "$TOKEN" \
    '{server: $server, caData: $caData, bearerToken: $bearerToken}')"

echo "✓ Cluster ${CLUSTER} registered. Apply the ExternalSecret to create the ArgoCD cluster secret:"
echo "  kubectl apply -f aws/argocd/cluster-secrets/eks-${REGION}.yaml -n argocd"
