#!/usr/bin/env bash
# bootstrap-multiregion.sh — Provision the IDP V2 active-standby multi-region platform
#
# Topology: eu-central-1 (primary / active) + us-east-1 (standby / DR)
#
# Run order:
#   Phase 0 : Pre-flight checks
#   Phase 1 : terraform/global — KMS, Route53, Transit Gateway, Aurora Global, S3, CloudFront+WAF
#   Phase 2 : Primary EKS workspace — full platform stack (matches bootstrap.sh phases)
#   Phase 3 : Standby EKS workspace — minimal stack (ArgoCD, ESO, Crossplane, Argo Rollouts)
#   Phase 4 : Post-wiring — IRSA patching, cluster registration, failover RBAC, Aurora
#             endpoints in Backstage secret, ArgoCD failover token, notifications
#
# Prerequisites (all must be true before running):
#   - AWS credentials configured (aws sts get-caller-identity succeeds)
#   - Terraform S3 backend bucket exists (created by bootstrap.sh on first-ever run, or manually)
#   - terraform, kubectl, helm, argocd, jq, docker in PATH
#   - GITHUB_TOKEN env var set (or pre-loaded in Secrets Manager)
#
# Usage:
#   ./scripts/bootstrap-multiregion.sh
#   ./scripts/bootstrap-multiregion.sh --primary-region eu-central-1 --standby-region us-east-1
#   ./scripts/bootstrap-multiregion.sh --skip-global   # if global module already applied
#   ./scripts/bootstrap-multiregion.sh --skip-standby  # primary only, wire standby later
#   ./scripts/bootstrap-multiregion.sh --skip-obs      # skip Thanos / Grafana
#   ./scripts/bootstrap-multiregion.sh --skip-ai       # skip KAgent / MLflow

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
PRIMARY_REGION="${PRIMARY_REGION:-eu-central-1}"
STANDBY_REGION="${STANDBY_REGION:-us-east-1}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TF_DIR="${ROOT_DIR}/terraform"
GLOBAL_TF_DIR="${ROOT_DIR}/terraform/global"

SKIP_GLOBAL="${SKIP_GLOBAL:-false}"
SKIP_STANDBY="${SKIP_STANDBY:-false}"
SKIP_OBS="${SKIP_OBS:-false}"
SKIP_AI="${SKIP_AI:-false}"
SKIP_GITOPS="${SKIP_GITOPS:-false}"
SKIP_POLICIES="${SKIP_POLICIES:-false}"

# ── Parse flags ───────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --primary-region) PRIMARY_REGION="$2"; shift 2 ;;
    --standby-region) STANDBY_REGION="$2"; shift 2 ;;
    --skip-global)    SKIP_GLOBAL=true;    shift ;;
    --skip-standby)   SKIP_STANDBY=true;   shift ;;
    --skip-obs)       SKIP_OBS=true;       shift ;;
    --skip-ai)        SKIP_AI=true;        shift ;;
    --skip-gitops)    SKIP_GITOPS=true;    shift ;;
    --skip-policies)  SKIP_POLICIES=true;  shift ;;
    *) echo "[ERROR] Unknown flag: $1"; exit 1 ;;
  esac
done

log()  { echo "[$(date +%T)] INFO  $*"; }
warn() { echo "[$(date +%T)] WARN  $*" >&2; }
err()  { echo "[$(date +%T)] ERROR $*" >&2; exit 1; }
step() { echo ""; echo "[$(date +%T)] ══ $* ══"; }

# ── Phase 0: Pre-flight ───────────────────────────────────────────────────────
step "Phase 0: Pre-flight checks"

REQUIRED_TOOLS=(aws terraform kubectl helm docker jq)
[[ "$SKIP_GITOPS" != "true" ]] && REQUIRED_TOOLS+=(argocd)

for cmd in "${REQUIRED_TOOLS[@]}"; do
  command -v "$cmd" &>/dev/null || err "'$cmd' not found in PATH"
done

aws sts get-caller-identity &>/dev/null || err "AWS credentials not configured"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
log "AWS account: ${ACCOUNT_ID}"
log "Primary region: ${PRIMARY_REGION}"
log "Standby region: ${STANDBY_REGION}"

# Warn if GITHUB_TOKEN is missing — non-fatal, bootstrap.sh handles this gracefully
if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  warn "GITHUB_TOKEN not set — GitHub integration will use REPLACE_ME placeholder."
  warn "Set it in Secrets Manager after bootstrap or export GITHUB_TOKEN=<token> and re-run."
fi

# ── Phase 1: Global Terraform module ─────────────────────────────────────────
# Provisions account-wide shared resources that span both regions:
#   KMS multi-region CMK, ECR replication, Route53 health-check failover,
#   Transit Gateway + inter-region peering, Aurora Global cluster,
#   S3 platform buckets (Thanos metrics, platform logs), CloudFront + WAF,
#   Global Accelerator, Security Hub + GuardDuty, CloudTrail,
#   Failover runner IAM role, S3 replication IAM role.
if [[ "$SKIP_GLOBAL" == "true" ]]; then
  log "Skipping Phase 1 (--skip-global)."
else
  step "Phase 1: Global Terraform module"
  cd "$GLOBAL_TF_DIR"
  terraform init -upgrade
  terraform apply -auto-approve \
    -var "primary_region=${PRIMARY_REGION}" \
    -var "standby_region=${STANDBY_REGION}"
  log "Global module apply complete."
  cd "$ROOT_DIR"
fi

# Read global outputs (needed for Phase 4 wiring even if --skip-global)
log "Reading global Terraform outputs..."
cd "$GLOBAL_TF_DIR"
FAILOVER_RUNNER_ROLE=$(terraform output -raw failover_runner_role_arn   2>/dev/null || echo "")
AURORA_WRITER=$(terraform output -raw aurora_primary_writer_endpoint    2>/dev/null || echo "")
AURORA_READER_PRIMARY=$(terraform output -raw aurora_primary_reader_endpoint  2>/dev/null || echo "")
AURORA_READER_STANDBY=$(terraform output -raw aurora_replica_reader_endpoint  2>/dev/null || echo "")
THANOS_BUCKET=$(terraform output -raw thanos_metrics_bucket_name        2>/dev/null || echo "")
cd "$ROOT_DIR"

# ── Phase 2: Primary EKS workspace ───────────────────────────────────────────
step "Phase 2: Primary cluster — ${PRIMARY_REGION}"

cd "$TF_DIR"
terraform init -upgrade
terraform workspace new "$PRIMARY_REGION" 2>/dev/null || terraform workspace select "$PRIMARY_REGION"
terraform apply -auto-approve \
  -var-file="tfvars/${PRIMARY_REGION}.tfvars"

PRIMARY_CLUSTER=$(terraform output -raw cluster_name)
BACKSTAGE_SECRET_ARN=$(terraform output -raw backstage_secret_arn)
TECHDOCS_BUCKET=$(terraform output -raw techdocs_bucket_name)
BACKSTAGE_ROLE_ARN=$(terraform output -raw backstage_role_arn)
CROSSPLANE_ROLE_PRIMARY=$(terraform output -raw crossplane_aws_role_arn)
DORA_ROLE_ARN=$(terraform output -raw dora_exporter_role_arn          2>/dev/null || echo "")
GRAFANA_ROLE_ARN=$(terraform output -raw grafana_role_arn             2>/dev/null || echo "")
ARGO_ROLE_ARN=$(terraform output -raw argo_workflows_role_arn         2>/dev/null || echo "")
DB_INIT_ROLE_ARN=$(terraform output -raw db_init_role_arn             2>/dev/null || echo "")
cd "$ROOT_DIR"

log "Primary cluster: ${PRIMARY_CLUSTER} (${PRIMARY_REGION})"

# Configure kubectl for the primary cluster (alias: hub)
log "Configuring kubectl for primary cluster (context: hub)..."
aws eks update-kubeconfig \
  --region "${PRIMARY_REGION}" \
  --name   "${PRIMARY_CLUSTER}" \
  --alias  hub
kubectl cluster-info --context hub

# ── Phase 2.1: Namespaces + RBAC ─────────────────────────────────────────────
log "Phase 2.1: Namespaces and RBAC..."
kubectl apply -f kubernetes/namespaces/namespaces.yaml       --context hub
kubectl apply -f kubernetes/namespaces/services-quota.yaml   --context hub
kubectl apply -f kubernetes/rbac/github-actions.yaml         --context hub
kubectl apply -f kubernetes/rbac/cluster-roles.yaml          --context hub

# ── Phase 2.2: Backstage IRSA ────────────────────────────────────────────────
log "Phase 2.2: Backstage ServiceAccount IRSA..."
kubectl apply -f kubernetes/backstage/rbac.yaml --context hub
kubectl annotate serviceaccount backstage \
  -n backstage \
  "eks.amazonaws.com/role-arn=${BACKSTAGE_ROLE_ARN}" \
  --overwrite --context hub

if [[ -n "$DB_INIT_ROLE_ARN" ]]; then
  kubectl apply -f aws/backstage/db-init-sa.yaml --context hub
  kubectl annotate serviceaccount db-init-sa \
    -n services \
    "eks.amazonaws.com/role-arn=${DB_INIT_ROLE_ARN}" \
    --overwrite --context hub
fi

kubectl create namespace monitoring --dry-run=client -o yaml | kubectl apply -f - --context hub

# ── Phase 2.3: External Secrets Operator ─────────────────────────────────────
log "Phase 2.3: External Secrets Operator..."
helm repo add external-secrets https://charts.external-secrets.io 2>/dev/null || true
helm repo update external-secrets
helm upgrade --install external-secrets external-secrets/external-secrets \
  --namespace external-secrets \
  --create-namespace \
  --set installCRDs=true \
  --kube-context hub \
  --wait --timeout 10m

kubectl wait --for=condition=ready pod \
  -l app.kubernetes.io/name=external-secrets \
  -n external-secrets \
  --timeout=300s \
  --context hub || warn "ESO pods not ready — proceeding"

kubectl create serviceaccount external-secrets-sa -n external-secrets \
  --dry-run=client -o yaml | kubectl apply -f - --context hub
kubectl annotate serviceaccount external-secrets-sa \
  -n external-secrets \
  "eks.amazonaws.com/role-arn=${BACKSTAGE_ROLE_ARN}" \
  --overwrite --context hub

sed "s/YOUR_AWS_REGION/${PRIMARY_REGION}/g" aws/external-secrets/cluster-secret-store.yaml \
  | kubectl apply -f - --context hub

for i in $(seq 1 12); do
  CSS=$(kubectl get clustersecretstore aws-secretsmanager \
    -o jsonpath='{.status.conditions[0].reason}' \
    --context hub 2>/dev/null || echo "NotReady")
  [[ "$CSS" == "StoreValid" ]] && { log "ClusterSecretStore ready."; break; }
  [[ $i -eq 12 ]] && warn "ClusterSecretStore may not be ready — proceeding"
  sleep 5
done

# ── Phase 2.4: Populate Secrets Manager ──────────────────────────────────────
log "Phase 2.4: Populating Secrets Manager..."

K8S_SA_TOKEN=$(kubectl get secret backstage-sa-token -n backstage \
  --context hub -o jsonpath='{.data.token}' 2>/dev/null | base64 --decode || echo "")

if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  BACKSTAGE_CATALOG_TOKEN=$(openssl rand -hex 32 2>/dev/null || \
    python3 -c "import secrets; print(secrets.token_hex(32))")
  AUTH_SESSION_SECRET=$(openssl rand -hex 32 2>/dev/null || \
    python3 -c "import secrets; print(secrets.token_hex(32))")

  CURRENT_SECRET=$(aws secretsmanager get-secret-value \
    --region "${PRIMARY_REGION}" \
    --secret-id "$BACKSTAGE_SECRET_ARN" \
    --query SecretString --output text)

  UPDATED_SECRET=$(echo "$CURRENT_SECRET" | python3 -c "
import json, sys, os
s = json.load(sys.stdin)
s['GITHUB_TOKEN'] = os.environ['GITHUB_TOKEN']
k8s = os.environ.get('K8S_SA_TOKEN','')
if k8s: s['K8S_SERVICE_ACCOUNT_TOKEN'] = k8s
for key in ('AUTH_GITHUB_CLIENT_ID','AUTH_GITHUB_CLIENT_SECRET','GRAFANA_ADMIN_PASSWORD',
            'GITHUB_APP_ID','GITHUB_APP_CLIENT_ID','GITHUB_APP_CLIENT_SECRET',
            'GITHUB_APP_PRIVATE_KEY','GITHUB_APP_WEBHOOK_SECRET'):
    val = os.environ.get(key,'')
    if val: s[key] = val
s['BACKSTAGE_CATALOG_TOKEN'] = os.environ['BACKSTAGE_CATALOG_TOKEN']
s['AUTH_SESSION_SECRET']     = os.environ['AUTH_SESSION_SECRET']
print(json.dumps(s))
" K8S_SA_TOKEN="$K8S_SA_TOKEN" \
  BACKSTAGE_CATALOG_TOKEN="$BACKSTAGE_CATALOG_TOKEN" \
  AUTH_SESSION_SECRET="$AUTH_SESSION_SECRET")

  aws secretsmanager update-secret \
    --region "${PRIMARY_REGION}" \
    --secret-id "$BACKSTAGE_SECRET_ARN" \
    --secret-string "$UPDATED_SECRET"
  log "Secrets Manager updated."
else
  warn "GITHUB_TOKEN not set — Secrets Manager not updated. Update manually after bootstrap."
fi

# Populate DORA exporter secret
if [[ -n "$DORA_ROLE_ARN" ]]; then
  kubectl apply -f aws/observability/dora/dora-cronjob.yaml --context hub
  kubectl annotate serviceaccount dora-exporter-sa \
    -n monitoring \
    "eks.amazonaws.com/role-arn=${DORA_ROLE_ARN}" \
    --overwrite --context hub
  kubectl create configmap dora-exporter-script \
    --from-file=dora-exporter.py=aws/observability/dora/dora-exporter.py \
    -n monitoring --dry-run=client -o yaml | kubectl apply -f - --context hub
fi

# ── Phase 2.5: Observability (kube-prometheus-stack + Thanos) ────────────────
if [[ "$SKIP_OBS" != "true" ]]; then
  log "Phase 2.5: Observability stack (Prometheus + Thanos)..."
  helm repo add prometheus-community https://prometheus-community.github.io/helm-charts 2>/dev/null || true
  helm repo update prometheus-community

  kubectl create configmap grafana-dashboards-idp \
    --from-file=observability/grafana/dashboards/ \
    -n monitoring --dry-run=client -o yaml | kubectl apply -f - --context hub

  kubectl apply -f kubernetes/monitoring/grafana-dora-dashboard-configmap.yaml  --context hub
  kubectl apply -f kubernetes/monitoring/grafana-qa-dashboard-configmap.yaml   --context hub

  tmp_obs=$(mktemp /tmp/prometheus-stack-values.XXXXXX.yaml)
  sed \
    -e "s|YOUR_AWS_REGION|${PRIMARY_REGION}|g" \
    -e "s|GRAFANA_IRSA_ROLE_ARN|${GRAFANA_ROLE_ARN}|g" \
    aws/observability/prometheus-stack-values.yaml > "$tmp_obs"

  helm upgrade --install prometheus prometheus-community/kube-prometheus-stack \
    --namespace monitoring \
    --create-namespace \
    --values "$tmp_obs" \
    --set grafana.adminPassword="${GRAFANA_ADMIN_PASSWORD:-changeme}" \
    --kube-context hub \
    --wait --timeout 10m
  rm -f "$tmp_obs"

  # Apply Thanos multi-region datasources for Grafana
  kubectl apply -f aws/observability/grafana-multi-region-datasources.yaml --context hub

  # Thanos — query, store-gateway, compactor (metrics cross-region aggregation)
  helm repo add bitnami https://charts.bitnami.com/bitnami 2>/dev/null || true
  helm repo update bitnami
  kubectl apply -f aws/observability/thanos/ --context hub 2>/dev/null || \
    log "  Thanos ArgoCD app applied — ArgoCD will install the chart."
fi

# ── Phase 2.6: Policies (OPA/Gatekeeper + Kyverno) ───────────────────────────
if [[ "$SKIP_POLICIES" != "true" ]]; then
  log "Phase 2.6: OPA/Gatekeeper + Kyverno policies..."
  helm repo add gatekeeper https://open-policy-agent.github.io/gatekeeper/charts 2>/dev/null || true
  helm repo update gatekeeper
  helm upgrade --install gatekeeper gatekeeper/gatekeeper \
    --namespace gatekeeper-system \
    --create-namespace \
    --set replicas=1 \
    --set auditInterval=60 \
    --kube-context hub \
    --wait --timeout 5m

  kubectl apply \
    -f kubernetes/policies/require-health-probes.yaml \
    -f kubernetes/policies/require-resource-limits.yaml \
    -f kubernetes/policies/require-labels.yaml \
    -f kubernetes/policies/deny-latest-tag.yaml \
    -f kubernetes/policies/require-cost-tags.yaml \
    --context hub 2>/dev/null || true

  kubectl wait crd \
    requirehealthprobes.constraints.gatekeeper.sh \
    requireresourcelimits.constraints.gatekeeper.sh \
    requirelabels.constraints.gatekeeper.sh \
    denylatestimgtag.constraints.gatekeeper.sh \
    requirecosttags.constraints.gatekeeper.sh \
    --for=condition=Established --timeout=120s --context hub

  kubectl apply \
    -f kubernetes/policies/require-health-probes.yaml \
    -f kubernetes/policies/require-resource-limits.yaml \
    -f kubernetes/policies/require-labels.yaml \
    -f kubernetes/policies/deny-latest-tag.yaml \
    -f kubernetes/policies/require-cost-tags.yaml \
    --context hub

  helm repo add kyverno https://kyverno.github.io/kyverno/ 2>/dev/null || true
  helm repo update kyverno
  helm upgrade --install kyverno kyverno/kyverno \
    --namespace kyverno \
    --create-namespace \
    --version 3.2.7 \
    --set replicaCount=2 \
    --kube-context hub \
    --wait --timeout 5m

  kubectl wait deployment kyverno-admission-controller \
    -n kyverno --for=condition=Available --timeout=120s --context hub

  kubectl apply -f kubernetes/policies/kyverno/team-quota-policy.yaml       --context hub
  kubectl apply -f kubernetes/policies/kyverno/crossplane-team-label-policy.yaml --context hub
fi

# ── Phase 2.7: ArgoCD (primary) ───────────────────────────────────────────────
if [[ "$SKIP_GITOPS" != "true" ]]; then
  log "Phase 2.7: ArgoCD (primary)..."
  helm repo add argo https://argoproj.github.io/argo-helm 2>/dev/null || true
  helm repo update argo
  helm upgrade --install argocd argo/argo-cd \
    --namespace argocd \
    --create-namespace \
    --values aws/argocd/argocd-helm-values.yaml \
    --kube-context hub \
    --wait --timeout 5m

  ARGOCD_ADMIN_PASSWORD=$(kubectl get secret argocd-initial-admin-secret \
    -n argocd --context hub -o jsonpath='{.data.password}' | base64 --decode)
  log "ArgoCD admin password: ${ARGOCD_ADMIN_PASSWORD}"

  # Primary app-of-apps (auto-sync enabled)
  kubectl apply -f aws/argocd/app-of-apps.yaml -n argocd --context hub

  # Crossplane
  CROSSPLANE_ROLE_PRIMARY_REAL="${CROSSPLANE_ROLE_PRIMARY}"
  if [[ -n "$CROSSPLANE_ROLE_PRIMARY_REAL" ]]; then
    sed "s|IRSA_ROLE_ARN|${CROSSPLANE_ROLE_PRIMARY_REAL}|g" \
      aws/crossplane/providers/deployment-runtime-config.yaml \
      | kubectl apply -f - --context hub
    kubectl apply -f aws/argocd/crossplane.yaml --context hub
  fi

  # Argo Rollouts (primary: 2 replicas)
  kubectl apply -f aws/argo-rollouts/argocd-application.yaml --context hub

  # Generate ArgoCD token for Backstage plugin
  ARGOCD_URL=""
  for i in $(seq 1 60); do
    ARGOCD_URL=$(kubectl get ingress argocd-server -n argocd \
      --context hub -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || echo "")
    [[ -n "$ARGOCD_URL" ]] && break
    [[ $i -eq 60 ]] && { warn "ArgoCD LB not ready after 5m — skipping token generation."; break; }
    sleep 5
  done

  if [[ -n "$ARGOCD_URL" ]]; then
    ADMIN_TOKEN=$(curl -s -k "https://${ARGOCD_URL}/api/v1/session" \
      -H "Content-Type: application/json" \
      -d "{\"username\":\"admin\",\"password\":\"${ARGOCD_ADMIN_PASSWORD}\"}" \
      | python3 -c "import json,sys; print(json.load(sys.stdin).get('token',''))" 2>/dev/null || echo "")

    if [[ -n "$ADMIN_TOKEN" ]]; then
      BS_ARGOCD_TOKEN=$(curl -s -k \
        "https://${ARGOCD_URL}/api/v1/account/backstage/token" \
        -H "Authorization: Bearer ${ADMIN_TOKEN}" -X POST \
        | python3 -c "import json,sys; print(json.load(sys.stdin).get('token',''))" 2>/dev/null || echo "")

      if [[ -n "$BS_ARGOCD_TOKEN" ]]; then
        CURRENT_SECRET=$(aws secretsmanager get-secret-value \
          --region "${PRIMARY_REGION}" \
          --secret-id "$BACKSTAGE_SECRET_ARN" \
          --query SecretString --output text)
        UPDATED=$(echo "$CURRENT_SECRET" | python3 -c "
import json,sys,os
s=json.load(sys.stdin)
s['ARGOCD_URL']='https://'+os.environ['U']
s['ARGOCD_AUTH_TOKEN']=os.environ['T']
print(json.dumps(s))" U="$ARGOCD_URL" T="$BS_ARGOCD_TOKEN")
        aws secretsmanager update-secret \
          --region "${PRIMARY_REGION}" \
          --secret-id "$BACKSTAGE_SECRET_ARN" \
          --secret-string "$UPDATED"
        log "ArgoCD token stored in Secrets Manager."
      fi
    fi
  fi
fi

# ── Phase 2.8: Backstage (primary) ───────────────────────────────────────────
log "Phase 2.8: Building and deploying Backstage..."
ECR_REGISTRY="${ACCOUNT_ID}.dkr.ecr.${PRIMARY_REGION}.amazonaws.com"
PRIMARY_CLUSTER_FINAL="${PRIMARY_CLUSTER}"
BACKSTAGE_IMAGE="${ECR_REGISTRY}/${PRIMARY_CLUSTER_FINAL}/backstage"

aws ecr get-login-password --region "${PRIMARY_REGION}" | \
  docker login --username AWS --password-stdin "${ECR_REGISTRY}"

IMAGE_TAG="$(git rev-parse --short HEAD 2>/dev/null || echo 'bootstrap')"
docker build \
  --platform linux/amd64 \
  --provenance=false \
  -f backstage/Dockerfile \
  -t "${BACKSTAGE_IMAGE}:${IMAGE_TAG}" \
  backstage/app/
docker push "${BACKSTAGE_IMAGE}:${IMAGE_TAG}"
log "Backstage image pushed: ${BACKSTAGE_IMAGE}:${IMAGE_TAG}"

kubectl apply -f aws/backstage/external-secret.yaml --context hub

for i in $(seq 1 12); do
  STATUS=$(kubectl get externalsecret backstage-secrets -n backstage \
    --context hub -o jsonpath='{.status.conditions[0].reason}' 2>/dev/null || echo "NotFound")
  [[ "$STATUS" == "SecretSynced" ]] && { log "ExternalSecret synced."; break; }
  [[ $i -eq 12 ]] && warn "ExternalSecret may not be synced — proceeding"
  sleep 5
done

kubectl apply -f kubernetes/backstage/configmap.yaml --context hub
sed "s|image: .*backstage:latest|image: ${BACKSTAGE_IMAGE}:${IMAGE_TAG}|g" \
  aws/backstage/deployment.yaml | kubectl apply -f - --context hub

BACKSTAGE_URL=""
for i in $(seq 1 36); do
  BACKSTAGE_URL=$(kubectl get svc backstage -n backstage \
    --context hub -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || echo "")
  [[ -n "$BACKSTAGE_URL" ]] && break
  [[ $i -eq 36 ]] && { warn "Backstage LB hostname not ready — URL patching skipped."; BACKSTAGE_URL="PENDING"; }
  sleep 10
done

if [[ "$BACKSTAGE_URL" != "PENDING" ]]; then
  kubectl get configmap backstage-config -n backstage --context hub -o json \
    | sed "s|BACKSTAGE_ALB_URL|${BACKSTAGE_URL}|g" \
    | kubectl apply -f - --context hub
  kubectl rollout restart deployment/backstage -n backstage --context hub
fi

# Backstage standby deployment (READONLY_MODE until failover)
sed "s|image: REPLACE_WITH_ECR_IMAGE|image: ${BACKSTAGE_IMAGE}:${IMAGE_TAG}|g" \
  aws/backstage/deployment-standby.yaml \
  | kubectl apply -f - --context hub 2>/dev/null || \
  warn "Standby Backstage deployment skipped (will be applied in Phase 3)."

# ── Phase 2.9: AI/ML platform ────────────────────────────────────────────────
if [[ "$SKIP_AI" != "true" ]]; then
  log "Phase 2.9: AI/ML platform (KAgent + MLflow)..."
  bash scripts/bootstrap-ai.sh --aws --region "${PRIMARY_REGION}" --cluster "${PRIMARY_CLUSTER}"
fi

# ── Phase 3: Standby EKS workspace ───────────────────────────────────────────
if [[ "$SKIP_STANDBY" == "true" ]]; then
  warn "Skipping Phase 3 (--skip-standby). Run later with --skip-global to wire the standby cluster."
else
  step "Phase 3: Standby cluster — ${STANDBY_REGION}"

  cd "$TF_DIR"
  terraform workspace new "$STANDBY_REGION" 2>/dev/null || terraform workspace select "$STANDBY_REGION"
  terraform apply -auto-approve \
    -var-file="tfvars/${STANDBY_REGION}.tfvars"

  STANDBY_CLUSTER=$(terraform output -raw cluster_name)
  CROSSPLANE_ROLE_STANDBY=$(terraform output -raw crossplane_aws_role_arn)
  cd "$ROOT_DIR"

  log "Standby cluster: ${STANDBY_CLUSTER} (${STANDBY_REGION})"

  aws eks update-kubeconfig \
    --region "${STANDBY_REGION}" \
    --name   "${STANDBY_CLUSTER}" \
    --alias  standby

  # Minimal stack: ESO, ArgoCD, Crossplane, Argo Rollouts
  # No Backstage, no full observability — this cluster is a warm standby

  # ESO on standby (reads from primary Secrets Manager via CRR)
  helm upgrade --install external-secrets external-secrets/external-secrets \
    --namespace external-secrets \
    --create-namespace \
    --set installCRDs=true \
    --kube-context standby \
    --wait --timeout 10m

  kubectl create serviceaccount external-secrets-sa -n external-secrets \
    --dry-run=client -o yaml | kubectl apply -f - --context standby

  BACKSTAGE_ROLE_STANDBY=$(cd "$TF_DIR" && \
    terraform workspace select "$STANDBY_REGION" &>/dev/null && \
    terraform output -raw backstage_role_arn 2>/dev/null || echo "$BACKSTAGE_ROLE_ARN")

  kubectl annotate serviceaccount external-secrets-sa \
    -n external-secrets \
    "eks.amazonaws.com/role-arn=${BACKSTAGE_ROLE_STANDBY}" \
    --overwrite --context standby

  sed "s/YOUR_AWS_REGION/${STANDBY_REGION}/g" aws/external-secrets/cluster-secret-store.yaml \
    | kubectl apply -f - --context standby

  # ArgoCD on standby (sync disabled by default — enabled on failover)
  helm upgrade --install argocd argo/argo-cd \
    --namespace argocd \
    --create-namespace \
    --values aws/argocd/argocd-helm-values.yaml \
    --kube-context standby \
    --wait --timeout 5m

  # Standby app-of-apps (auto-sync disabled — ArgoCD monitors but does not sync)
  kubectl apply -f aws/argocd/app-of-apps-standby.yaml -n argocd --context standby

  # Crossplane on standby
  sed "s|REPLACE_WITH_STANDBY_IRSA_ARN|${CROSSPLANE_ROLE_STANDBY}|g" \
    aws/crossplane/providers/provider-config-us-east-1.yaml \
    | kubectl apply -f - --context standby

  # Argo Rollouts on standby (1 replica)
  kubectl apply -f aws/argo-rollouts/argocd-application.yaml --context standby

  # Backstage warm standby
  sed "s|image: REPLACE_WITH_ECR_IMAGE|image: ${BACKSTAGE_IMAGE}:${IMAGE_TAG}|g" \
    aws/backstage/deployment-standby.yaml | kubectl apply -f - --context standby

  # Namespaces + RBAC
  kubectl apply -f kubernetes/namespaces/namespaces.yaml     --context standby
  kubectl apply -f kubernetes/rbac/cluster-roles.yaml        --context standby

  log "Standby cluster provisioned."
fi

# ── Phase 4: Post-wiring ─────────────────────────────────────────────────────
step "Phase 4: Post-wiring (IRSA, cluster registration, failover, Aurora, notifications)"

if [[ "$SKIP_GITOPS" == "true" ]]; then
  warn "Skipping Phase 4 ArgoCD wiring (--skip-gitops)."
else
  # 4.1 — Register both clusters in ArgoCD hub
  log "4.1: Registering clusters in ArgoCD hub..."
  bash scripts/register-argocd-cluster.sh \
    --cluster "$PRIMARY_CLUSTER" \
    --region  "$PRIMARY_REGION"

  if [[ "$SKIP_STANDBY" != "true" ]]; then
    bash scripts/register-argocd-cluster.sh \
      --cluster "$STANDBY_CLUSTER" \
      --region  "$STANDBY_REGION"
  fi

  # 4.2 — Apply failover-runner RBAC with real IRSA ARN
  if [[ -n "$FAILOVER_RUNNER_ROLE" ]]; then
    log "4.2: Applying failover-runner RBAC..."
    sed "s|REPLACE_WITH_FAILOVER_RUNNER_ROLE_ARN|${FAILOVER_RUNNER_ROLE}|g" \
      aws/argo-workflows/failover-runner-rbac.yaml \
      | kubectl apply -f - --context hub
  else
    warn "4.2: failover_runner_role_arn not found in global TF output — skipping."
  fi

  # 4.3 — Populate Aurora Global endpoints in Backstage secret
  if [[ -n "$AURORA_WRITER" ]]; then
    log "4.3: Writing Aurora endpoints to Secrets Manager..."
    CURRENT=$(aws secretsmanager get-secret-value \
      --region "$PRIMARY_REGION" \
      --secret-id "idp-mvp/backstage" \
      --query "SecretString" --output text)

    UPDATED=$(echo "$CURRENT" | jq \
      --arg writer   "$AURORA_WRITER" \
      --arg reader   "$AURORA_READER_PRIMARY" \
      --arg rstandby "$AURORA_READER_STANDBY" \
      '.POSTGRES_HOST          = $writer |
       .POSTGRES_HOST_WRITER   = $writer |
       .POSTGRES_HOST_READER   = $reader |
       .POSTGRES_HOST_READER_STANDBY = $rstandby')

    aws secretsmanager put-secret-value \
      --region "$PRIMARY_REGION" \
      --secret-id "idp-mvp/backstage" \
      --secret-string "$UPDATED"
    log "Aurora endpoints written."
  else
    warn "4.3: Aurora outputs not found — update POSTGRES_HOST_* in Secrets Manager manually."
  fi

  # 4.4 — Generate ArgoCD failover token
  log "4.4: Generating ArgoCD failover token..."
  ARGOCD_SERVER=$(kubectl get svc argocd-server -n argocd \
    --context hub -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || echo "")

  if [[ -n "$ARGOCD_SERVER" ]]; then
    FAILOVER_TOKEN=$(argocd account generate-token \
      --account failover-runner \
      --server "$ARGOCD_SERVER" \
      --insecure 2>/dev/null || echo "REPLACE_ME_argocd_account_generate-token")

    kubectl create secret generic argocd-failover-token \
      --from-literal=token="$FAILOVER_TOKEN" \
      -n argo \
      --context hub \
      --dry-run=client -o yaml | kubectl apply -f - --context hub
    log "ArgoCD failover token stored in K8s secret."
  else
    warn "4.4: ArgoCD LB not available — create argocd-failover-token secret manually."
  fi

  # 4.5 — Apply ArgoCD cluster ExternalSecrets + notifications
  log "4.5: Applying ArgoCD cluster ExternalSecrets and notifications..."
  kubectl apply -f aws/argocd/cluster-secrets/ -n argocd --context hub
  kubectl apply -f aws/argocd/notifications-config.yaml  --context hub

  # 4.6 — AlertManager Slack webhook
  if [[ -n "${SLACK_WEBHOOK_URL:-}" ]]; then
    log "4.6: Configuring AlertManager Slack webhook..."
    kubectl create secret generic alertmanager-slack-webhook \
      --from-literal=webhook-url="${SLACK_WEBHOOK_URL}" \
      -n monitoring --dry-run=client -o yaml | kubectl apply -f - --context hub
    kubectl apply -f observability/alertmanager/alertmanager-config.yaml --context hub
  else
    warn "4.6: SLACK_WEBHOOK_URL not set — AlertManager Slack routing skipped."
  fi
fi

# ── Done ──────────────────────────────────────────────────────────────────────
_alb() { kubectl get ingress "$1" -n "$2" --context hub \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null \
  | grep -v '^$' || echo "pending..."; }

echo ""
echo "[$(date +%T)] ╔══════════════════════════════════════════════════════════════════════╗"
echo "[$(date +%T)] ║           Bootstrap complete — V2 Multi-Region platform             ║"
echo "[$(date +%T)] ╠══════════════════════════════════════════════════════════════════════╣"
echo "[$(date +%T)] ║  PRIMARY   ${PRIMARY_CLUSTER} (${PRIMARY_REGION})"
echo "[$(date +%T)] ║  STANDBY   ${STANDBY_CLUSTER:-skipped} (${STANDBY_REGION})"
echo "[$(date +%T)] ╠══════════════════════════════════════════════════════════════════════╣"
echo "[$(date +%T)] ║  DEVELOPER PORTAL"
echo "[$(date +%T)] ║    Backstage (primary)   http://${BACKSTAGE_URL:-PENDING}"
echo "[$(date +%T)] ║    Backstage (standby)   warm standby — READONLY until failover"
echo "[$(date +%T)] ╠══════════════════════════════════════════════════════════════════════╣"
echo "[$(date +%T)] ║  PLATFORM SERVICES (primary)"
echo "[$(date +%T)] ║    ArgoCD       http://$(_alb argocd-server argocd)"
echo "[$(date +%T)] ║    Grafana      http://$(_alb grafana monitoring)"
echo "[$(date +%T)] ║    Prometheus   http://$(_alb prometheus monitoring)"
echo "[$(date +%T)] ╠══════════════════════════════════════════════════════════════════════╣"
echo "[$(date +%T)] ║  DISASTER RECOVERY"
echo "[$(date +%T)] ║    Failover runbook:  argo submit aws/argo-workflows/failover-runbook.yaml"
echo "[$(date +%T)] ║    Aurora writer:     ${AURORA_WRITER:-not available}"
echo "[$(date +%T)] ╚══════════════════════════════════════════════════════════════════════╝"
echo ""
echo "Next steps:"
echo "  1. Set Slack bot token:   kubectl edit secret argocd-notifications-secret -n argocd --context hub"
echo "  2. Test failover (GameDay): argo submit aws/argo-workflows/failover-runbook.yaml --context hub"
echo "  3. Review Thanos:         kubectl get pods -n monitoring --context hub | grep thanos"
echo "  4. Verify standby sync:   kubectl get applications -n argocd --context standby"
echo ""
