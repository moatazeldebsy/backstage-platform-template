#!/usr/bin/env bash
# bootstrap.sh — Provision the IDP MVP platform end-to-end
# Usage: ./scripts/bootstrap.sh [--region us-east-1] [--cluster-name idp-mvp] [--skip-*]
set -euo pipefail

# ── Defaults ─────────────────────────────────────────────────────────────────
AWS_REGION="${AWS_REGION:-us-east-1}"
CLUSTER_NAME="${CLUSTER_NAME:-idp-mvp}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TF_DIR="${ROOT_DIR}/terraform"

SKIP_OBS="${SKIP_OBS:-false}"
SKIP_GITOPS="${SKIP_GITOPS:-false}"
SKIP_POLICIES="${SKIP_POLICIES:-false}"
SKIP_DORA="${SKIP_DORA:-false}"
SKIP_AI="${SKIP_AI:-false}"

log()  { echo "[$(date +%T)] INFO  $*"; }
err()  { echo "[$(date +%T)] ERROR $*" >&2; exit 1; }

# ── Parse flags ───────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --region)        AWS_REGION="$2"; shift 2 ;;
    --cluster-name)  CLUSTER_NAME="$2"; shift 2 ;;
    --skip-obs)      SKIP_OBS=true; shift ;;
    --skip-gitops)   SKIP_GITOPS=true; shift ;;
    --skip-policies) SKIP_POLICIES=true; shift ;;
    --skip-dora)     SKIP_DORA=true; shift ;;
    --skip-ai)       SKIP_AI=true; shift ;;
    *) err "Unknown flag: $1" ;;
  esac
done

# ── Pre-flight checks ─────────────────────────────────────────────────────────
for cmd in aws terraform kubectl helm docker; do
  command -v "$cmd" &>/dev/null || err "'$cmd' not found in PATH"
done

aws sts get-caller-identity &>/dev/null || err "AWS credentials not configured"

log "Starting IDP MVP bootstrap (cluster=$CLUSTER_NAME, region=$AWS_REGION)"

# ── Phase 1: Terraform — EKS + ECR + IAM + RDS + S3 + Secrets Manager ────────
log "Phase 1: Provisioning infrastructure with Terraform..."

cd "$TF_DIR"
terraform init -upgrade
terraform apply -auto-approve \
  -var "aws_region=${AWS_REGION}" \
  -var "cluster_name=${CLUSTER_NAME}"

BACKSTAGE_SECRET_ARN=$(terraform output -raw backstage_secret_arn)
TECHDOCS_BUCKET=$(terraform output -raw techdocs_bucket_name)
BACKSTAGE_ROLE_ARN=$(terraform output -raw backstage_role_arn)

log "Terraform apply complete."

# ── Phase 2: Configure kubectl ────────────────────────────────────────────────
log "Phase 2: Configuring kubectl..."
aws eks update-kubeconfig --region "${AWS_REGION}" --name "${CLUSTER_NAME}"
kubectl cluster-info

# ── Phase 3: Platform namespaces + RBAC ──────────────────────────────────────
log "Phase 3: Creating namespaces and RBAC..."
cd "$ROOT_DIR"
kubectl apply -f kubernetes/namespaces/namespaces.yaml
kubectl apply -f kubernetes/rbac/github-actions.yaml

# ── Phase 3.5: Annotate backstage ServiceAccount with IRSA role ARN ──────────
log "Phase 3.5: Setting up Backstage ServiceAccount with IRSA..."
kubectl apply -f kubernetes/backstage/rbac.yaml
kubectl annotate serviceaccount backstage \
  -n backstage \
  "eks.amazonaws.com/role-arn=${BACKSTAGE_ROLE_ARN}" \
  --overwrite

# DB-init ServiceAccount (IRSA for Secrets Manager access)
DB_INIT_ROLE_ARN=$(cd terraform && terraform output -raw db_init_role_arn)
kubectl apply -f kubernetes/backstage/db-init-sa.yaml
kubectl annotate serviceaccount db-init-sa \
  -n services \
  "eks.amazonaws.com/role-arn=${DB_INIT_ROLE_ARN}" \
  --overwrite

# DORA exporter ServiceAccount IRSA annotation (applied after ESO installs the CRD)
DORA_ROLE_ARN=$(cd terraform && terraform output -raw dora_exporter_role_arn)
kubectl create namespace monitoring --dry-run=client -o yaml | kubectl apply -f -

# ── Phase 3.6: Install External Secrets Operator ─────────────────────────────
log "Phase 3.6: Installing External Secrets Operator..."
helm repo add external-secrets https://charts.external-secrets.io 2>/dev/null || true
helm repo update
helm upgrade --install external-secrets external-secrets/external-secrets \
  --namespace external-secrets \
  --create-namespace \
  --set installCRDs=true \
  --wait

# ── Phase 3.6a: Create ClusterSecretStore (AWS Secrets Manager backend for ESO) ─
log "Phase 3.6a: Creating ClusterSecretStore for AWS Secrets Manager..."

# Annotate the ESO ServiceAccount with the Backstage IRSA role so it can
# authenticate to Secrets Manager via pod identity (no static credentials).
kubectl annotate serviceaccount external-secrets-sa \
  -n external-secrets \
  "eks.amazonaws.com/role-arn=${BACKSTAGE_ROLE_ARN}" \
  --overwrite

# Substitute the AWS region placeholder and apply
sed "s/YOUR_AWS_REGION/${AWS_REGION}/g" kubernetes/external-secrets/cluster-secret-store.yaml \
  | kubectl apply -f -

# Wait up to 60s for the ClusterSecretStore to become Ready
for i in $(seq 1 12); do
  CSS_STATUS=$(kubectl get clustersecretstore aws-secretsmanager \
    -o jsonpath='{.status.conditions[0].reason}' 2>/dev/null || echo "NotReady")
  if [[ "$CSS_STATUS" == "StoreValid" ]]; then
    log "  ClusterSecretStore aws-secretsmanager is Ready."
    break
  fi
  [[ $i -eq 12 ]] && log "  WARNING: ClusterSecretStore may not be ready — proceeding anyway."
  sleep 5
done

# Deploy DORA cronjob now that ExternalSecret CRD exists
if [[ "$SKIP_DORA" != "true" ]]; then
  kubectl apply -f observability/dora/dora-cronjob.yaml
  kubectl annotate serviceaccount dora-exporter-sa \
    -n monitoring \
    "eks.amazonaws.com/role-arn=${DORA_ROLE_ARN}" \
    --overwrite
  kubectl create configmap dora-exporter-script \
    --from-file=dora-exporter.py=observability/dora/dora-exporter.py \
    -n monitoring --dry-run=client -o yaml | kubectl apply -f -
fi

# ── Phase 3.7: Populate Secrets Manager with runtime secrets ─────────────────
log "Phase 3.7: Updating Secrets Manager with runtime credentials..."

# Get the K8s service account token for Backstage → K8s integration
K8S_SA_TOKEN=$(kubectl get secret backstage-sa-token -n backstage \
  -o jsonpath='{.data.token}' 2>/dev/null | base64 --decode || echo "")

if [[ -z "$K8S_SA_TOKEN" ]]; then
  log "  backstage-sa-token not found yet; K8S_SERVICE_ACCOUNT_TOKEN left as REPLACE_ME"
  log "  Run: kubectl get secret backstage-sa-token -n backstage -o jsonpath='{.data.token}' | base64 -d"
  log "  Then: aws secretsmanager update-secret --secret-id idp-mvp/backstage ..."
fi

# GITHUB_TOKEN must be supplied via environment variable
if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  log "  WARNING: GITHUB_TOKEN env var not set — leaving as REPLACE_ME in Secrets Manager"
  log "  Set GITHUB_TOKEN and re-run, or update the secret manually:"
  log "  aws secretsmanager get-secret-value --secret-id idp-mvp/backstage"
else
  # Merge current secret value with real GITHUB_TOKEN and K8s SA token
  CURRENT_SECRET=$(aws secretsmanager get-secret-value \
    --secret-id "$BACKSTAGE_SECRET_ARN" \
    --query SecretString --output text)

  UPDATED_SECRET=$(echo "$CURRENT_SECRET" | python3 -c "
import json, sys, os
s = json.load(sys.stdin)
s['GITHUB_TOKEN'] = os.environ['GITHUB_TOKEN']
k8s_token = os.environ.get('K8S_SA_TOKEN', '')
if k8s_token:
    s['K8S_SERVICE_ACCOUNT_TOKEN'] = k8s_token
client_id = os.environ.get('AUTH_GITHUB_CLIENT_ID', '')
client_secret = os.environ.get('AUTH_GITHUB_CLIENT_SECRET', '')
if client_id:
    s['AUTH_GITHUB_CLIENT_ID'] = client_id
if client_secret:
    s['AUTH_GITHUB_CLIENT_SECRET'] = client_secret
grafana_pw = os.environ.get('GRAFANA_ADMIN_PASSWORD', '')
if grafana_pw:
    s['GRAFANA_ADMIN_PASSWORD'] = grafana_pw
print(json.dumps(s))
" K8S_SA_TOKEN="$K8S_SA_TOKEN")

  aws secretsmanager update-secret \
    --secret-id "$BACKSTAGE_SECRET_ARN" \
    --secret-string "$UPDATED_SECRET"
  log "  Secrets Manager updated with GITHUB_TOKEN + GitHub OAuth + Grafana credentials."
fi

# ── Phase 4: Observability ────────────────────────────────────────────────────
log "Phase 4: Installing observability stack (kube-prometheus-stack)..."
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts 2>/dev/null || true
helm repo update

# Grafana IRSA role ARN (injected into the Helm values via --set)
GRAFANA_ROLE_ARN=$(cd "${TF_DIR}" && terraform output -raw grafana_role_arn 2>/dev/null || echo "")

# Create Grafana dashboard ConfigMaps before installing the chart so that
# Grafana picks them up on first boot rather than requiring a pod restart.
kubectl create configmap grafana-dashboards-idp \
  --from-file=observability/grafana/dashboards/ \
  -n monitoring --dry-run=client -o yaml | kubectl apply -f -

kubectl apply -f kubernetes/monitoring/grafana-dora-dashboard-configmap.yaml
kubectl apply -f kubernetes/monitoring/grafana-qa-dashboard-configmap.yaml

# Substitute region and Grafana IRSA ARN placeholders in the values file
tmp_obs_values=$(mktemp /tmp/prometheus-stack-values-aws.XXXXXX.yaml)
sed \
  -e "s|YOUR_AWS_REGION|${AWS_REGION}|g" \
  -e "s|GRAFANA_IRSA_ROLE_ARN|${GRAFANA_ROLE_ARN}|g" \
  observability/prometheus-stack-values-aws.yaml > "${tmp_obs_values}"

helm upgrade --install prometheus prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --create-namespace \
  --values "${tmp_obs_values}" \
  --set grafana.adminPassword="${GRAFANA_ADMIN_PASSWORD:-changeme}" \
  --wait --timeout 10m
rm -f "${tmp_obs_values}"

# ── Phase 4a: Prometheus Pushgateway ─────────────────────────────────────────
log "Phase 4a: Installing Prometheus Pushgateway..."
helm upgrade --install prometheus-pushgateway prometheus-community/prometheus-pushgateway \
  --namespace monitoring \
  --set serviceMonitor.enabled=true \
  --set "serviceMonitor.additionalLabels.release=prometheus" \
  --set resources.requests.cpu=10m \
  --set resources.requests.memory=32Mi \
  --set resources.limits.cpu=100m \
  --set resources.limits.memory=64Mi \
  --set "extraArgs[0]=--web.enable-admin-api" \
  --wait

# ── Phase 4b: OpenCost ────────────────────────────────────────────────────────
log "Phase 4b: Installing OpenCost (cluster cost visibility)..."
helm repo add opencost https://opencost.github.io/opencost-helm-chart 2>/dev/null || true
helm repo update

kubectl apply -f kubernetes/finops/opencost.yaml

helm upgrade --install opencost opencost/opencost \
  --namespace opencost \
  --set opencost.prometheus.internal.enabled=false \
  --set opencost.prometheus.external.enabled=true \
  --set "opencost.prometheus.external.url=http://prometheus-operated.monitoring.svc.cluster.local:9090" \
  --set opencost.exporter.defaultClusterId="${CLUSTER_NAME}" \
  --wait --timeout 5m

log "OpenCost installed."

# ── Phase 3.8: Install OPA/Gatekeeper + apply golden-path policies ───────────
if [[ "$SKIP_POLICIES" != "true" ]]; then
log "Phase 3.8: Installing OPA/Gatekeeper policy engine..."
helm repo add gatekeeper https://open-policy-agent.github.io/gatekeeper/charts 2>/dev/null || true
helm repo update
helm upgrade --install gatekeeper gatekeeper/gatekeeper \
  --namespace gatekeeper-system \
  --create-namespace \
  --set replicas=1 \
  --set auditInterval=60 \
  --set logLevel=WARNING \
  --wait \
  --timeout 5m

log "  Applying golden-path ConstraintTemplates..."
# Pass 1: apply full files — creates ConstraintTemplates (Constraint instances
# fail because their CRDs don't exist yet; errors are expected and suppressed).
kubectl apply \
  -f kubernetes/policies/require-health-probes.yaml \
  -f kubernetes/policies/require-resource-limits.yaml \
  -f kubernetes/policies/require-labels.yaml \
  -f kubernetes/policies/deny-latest-tag.yaml \
  -f kubernetes/policies/require-cost-tags.yaml 2>/dev/null || true

# Wait for Gatekeeper to register the CRDs from the ConstraintTemplates
log "  Waiting for ConstraintTemplate CRDs to become established..."
kubectl wait crd \
  requirehealthprobes.constraints.gatekeeper.sh \
  requireresourcelimits.constraints.gatekeeper.sh \
  requirelabels.constraints.gatekeeper.sh \
  denylatestimgtag.constraints.gatekeeper.sh \
  requirecosttags.constraints.gatekeeper.sh \
  --for=condition=Established \
  --timeout=120s

# Pass 2: CRDs now exist — apply again to create the Constraint instances.
kubectl apply \
  -f kubernetes/policies/require-health-probes.yaml \
  -f kubernetes/policies/require-resource-limits.yaml \
  -f kubernetes/policies/require-labels.yaml \
  -f kubernetes/policies/deny-latest-tag.yaml \
  -f kubernetes/policies/require-cost-tags.yaml
log "  OPA/Gatekeeper policies applied (health-probes, resource-limits, labels, deny-latest-tag, cost-tags)."

# ── Phase 4.4: Tech Insights Exporter ────────────────────────────────────────
log "Phase 4.4: Deploying Tech Insights Exporter CronJob..."
kubectl create configmap tech-insights-exporter-script \
  --from-file=exporter.py=observability/tech-insights-exporter/exporter.py \
  -n monitoring --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f observability/tech-insights-exporter/cronjob.yaml
log "  Tech Insights Exporter deployed (pushes scorecard metrics to Pushgateway every 15m)."

# ── Phase 4.5: Install ArgoCD ────────────────────────────────────────────────
if [[ "$SKIP_GITOPS" != "true" ]]; then
log "Phase 4.5: Installing ArgoCD..."
helm repo add argo https://argoproj.github.io/argo-helm 2>/dev/null || true
helm repo update
helm upgrade --install argocd argo/argo-cd \
  --namespace argocd \
  --create-namespace \
  --values kubernetes/argocd/argocd-helm-values.yaml \
  --wait \
  --timeout 5m

log "  ArgoCD installed."
ARGOCD_ADMIN_PASSWORD=$(kubectl get secret argocd-initial-admin-secret -n argocd \
  -o jsonpath='{.data.password}' | base64 --decode)
log "  ArgoCD admin password: ${ARGOCD_ADMIN_PASSWORD}"

# ── Phase 4.6: Apply the GitOps ApplicationSet ───────────────────────────────
log "Phase 4.6: Applying ArgoCD ApplicationSet (GitOps)..."
kubectl apply -f kubernetes/argocd/app-of-apps.yaml -n argocd
log "  ApplicationSet applied — ArgoCD will sync services once image tags are set."

# ── Phase 4.7: Create Backstage read-only API token for ArgoCD plugin ────────
log "Phase 4.7: Generating ArgoCD API token for Backstage..."

# Wait up to 5 minutes for ArgoCD ALB ingress to get a hostname
ARGOCD_URL=""
for i in $(seq 1 60); do
  # ArgoCD uses ALB Ingress (not LoadBalancer service) — read from Ingress object
  ARGOCD_URL=$(kubectl get ingress argocd-server -n argocd \
    -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || echo "")
  [[ -n "$ARGOCD_URL" ]] && break
  [[ $i -eq 60 ]] && { log "  WARNING: ArgoCD LB not ready after 5m — skipping token generation."; }
  sleep 5
done

if [[ -n "$ARGOCD_URL" ]]; then
  # Login and get admin token
  ADMIN_TOKEN=$(curl -s -k "https://${ARGOCD_URL}/api/v1/session" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"admin\",\"password\":\"${ARGOCD_ADMIN_PASSWORD}\"}" \
    | python3 -c "import json,sys; print(json.load(sys.stdin).get('token',''))" 2>/dev/null || echo "")

  if [[ -n "$ADMIN_TOKEN" ]]; then
    # Generate a token for the backstage local account
    BACKSTAGE_ARGOCD_TOKEN=$(curl -s -k \
      "https://${ARGOCD_URL}/api/v1/account/backstage/token" \
      -H "Authorization: Bearer ${ADMIN_TOKEN}" \
      -X POST \
      | python3 -c "import json,sys; print(json.load(sys.stdin).get('token',''))" 2>/dev/null || echo "")

    if [[ -n "$BACKSTAGE_ARGOCD_TOKEN" ]]; then
      # Store in Secrets Manager alongside existing Backstage credentials
      CURRENT_SECRET=$(aws secretsmanager get-secret-value \
        --secret-id "$BACKSTAGE_SECRET_ARN" \
        --query SecretString --output text)
      UPDATED_SECRET=$(echo "$CURRENT_SECRET" | python3 -c "
import json, sys, os
s = json.load(sys.stdin)
s['ARGOCD_URL'] = 'https://' + os.environ['ARGOCD_URL']
s['ARGOCD_AUTH_TOKEN'] = os.environ['BACKSTAGE_ARGOCD_TOKEN']
print(json.dumps(s))
" ARGOCD_URL="$ARGOCD_URL" BACKSTAGE_ARGOCD_TOKEN="$BACKSTAGE_ARGOCD_TOKEN")
      aws secretsmanager update-secret \
        --secret-id "$BACKSTAGE_SECRET_ARN" \
        --secret-string "$UPDATED_SECRET"
      log "  ArgoCD token stored in Secrets Manager."
    fi
  fi
fi
fi # --skip-gitops

# ── Phase 5: Build + push hello-service seed image ───────────────────────────
# CI (GitHub Actions) manages ongoing deployments via GitOps (update-image-tag job).
# This phase seeds the initial image so ArgoCD has something to deploy on first run.
log "Phase 5: Building and pushing hello-service seed image..."
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_REGISTRY="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
IMAGE_REPO="${ECR_REGISTRY}/${CLUSTER_NAME}/hello-service"
IMAGE_TAG="$(git rev-parse --short HEAD 2>/dev/null || echo 'bootstrap')"

aws ecr get-login-password --region "${AWS_REGION}" | \
  docker login --username AWS --password-stdin "${ECR_REGISTRY}"

docker build \
  --platform linux/amd64 \
  --provenance=false \
  --build-arg VERSION="${IMAGE_TAG}" \
  -t "${IMAGE_REPO}:${IMAGE_TAG}" \
  -t "${IMAGE_REPO}:latest" \
  services/hello-service

docker push "${IMAGE_REPO}:${IMAGE_TAG}"
docker push "${IMAGE_REPO}:latest"

# Write seed image tag into helm-values-dev.yaml so ArgoCD syncs immediately
IMAGE_REPO_ESC="${IMAGE_REPO}" IMAGE_TAG_ESC="${IMAGE_TAG}" python3 - <<'PYEOF'
import os, re
f = 'services/hello-service/helm-values-dev.yaml'
content = open(f).read()
content = re.sub(r'(repository:\s*)\S+', r'\g<1>' + os.environ['IMAGE_REPO_ESC'], content)
content = re.sub(r'(tag:\s*)\S+',        r'\g<1>' + os.environ['IMAGE_TAG_ESC'],  content)
open(f, 'w').write(content)
PYEOF
git config user.name  "idp-bot" 2>/dev/null || true
git config user.email "idp-bot@platform" 2>/dev/null || true
git add services/hello-service/helm-values-dev.yaml
git diff --staged --quiet || \
  git commit -m "chore(gitops): hello-service seed image ${IMAGE_TAG} [skip ci]" && \
  git push 2>/dev/null || log "  (git push skipped — not in a git repo or no remote)"

log "hello-service seed image pushed — ArgoCD will deploy to dev namespace."

# ── Phase 5.5: Build + push Backstage image ───────────────────────────────────
log "Phase 5.5: Building and pushing Backstage image..."
BACKSTAGE_IMAGE="${ECR_REGISTRY}/${CLUSTER_NAME}/backstage"

# Compile TypeScript backend — produces packages/backend/dist/{bundle,skeleton}.tar.gz
log "  Compiling Backstage backend (yarn build:backend)..."
(cd backstage/app && yarn install --frozen-lockfile && yarn build:backend --config ../../app-config.yaml)

docker build \
  --platform linux/amd64 \
  --provenance=false \
  -f backstage/Dockerfile \
  -t "${BACKSTAGE_IMAGE}:latest" \
  backstage/app/

docker push "${BACKSTAGE_IMAGE}:latest"
log "Backstage image pushed to ECR."

# ── Phase 5.6: Deploy Backstage ───────────────────────────────────────────────
log "Phase 5.6: Deploying Backstage..."

# Apply External Secrets (creates backstage-secrets K8s Secret from Secrets Manager)
kubectl apply -f kubernetes/backstage/external-secret.yaml

# Wait for ESO to sync the secret (up to 60s)
log "  Waiting for ExternalSecret to sync..."
for i in $(seq 1 12); do
  STATUS=$(kubectl get externalsecret backstage-secrets -n backstage \
    -o jsonpath='{.status.conditions[0].reason}' 2>/dev/null || echo "NotFound")
  if [[ "$STATUS" == "SecretSynced" ]]; then
    log "  Secret synced successfully."
    break
  fi
  [[ $i -eq 12 ]] && log "  WARNING: Secret may not be synced yet — proceeding anyway."
  sleep 5
done

# Apply configmaps (base-config + production overrides) and deployment
kubectl apply -f kubernetes/backstage/configmap.yaml
kubectl apply -f kubernetes/backstage/deployment.yaml

# Wait for Backstage LB to get a hostname (up to 3 min)
log "  Waiting for Backstage LoadBalancer hostname..."
for i in $(seq 1 18); do
  BACKSTAGE_URL=$(kubectl get svc backstage -n backstage \
    -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || echo "")
  [[ -n "$BACKSTAGE_URL" ]] && break
  [[ $i -eq 18 ]] && { log "  LoadBalancer hostname not ready — skipping URL patch."; BACKSTAGE_URL="PENDING"; }
  sleep 10
done

# Patch the configmap with the real ALB URL and restart the pod
if [[ "$BACKSTAGE_URL" != "PENDING" ]]; then
  kubectl get configmap backstage-config -n backstage -o json \
    | sed "s|BACKSTAGE_ALB_URL|${BACKSTAGE_URL}|g" \
    | kubectl apply -f -
  kubectl rollout restart deployment/backstage -n backstage
fi

kubectl rollout status deployment/backstage -n backstage --timeout=120s || \
  log "  WARNING: Backstage rollout did not complete in time — check pod logs."

# ── Phase 5.7: Catalog exporter CronJob ──────────────────────────────────────
if [[ "$SKIP_DORA" != "true" ]]; then
  log "Phase 5.7: Deploying catalog exporter CronJob..."
  cd "$ROOT_DIR"
  bash scripts/apply-catalog-exporter.sh
  log "  Catalog exporter deployed."
fi

# ── Phase 6: AI/ML platform (KAgent + MLflow + MCP servers) ──────────────────
if [[ "$SKIP_AI" != "true" ]]; then
  log "Phase 6: Deploying AI/ML platform..."
  cd "$ROOT_DIR"
  bash scripts/bootstrap-ai.sh --aws --region "${AWS_REGION}" --cluster "${CLUSTER_NAME}"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
log ""
log "Bootstrap complete! Platform summary:"
log "  Cluster:        $(kubectl config current-context)"
log "  hello-service:  $(kubectl get svc hello-service -n services -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || echo 'pending...')"
log "  Backstage:      http://${BACKSTAGE_URL:-PENDING}"
log "  Grafana:        $(kubectl get ingress -n monitoring -l app.kubernetes.io/name=grafana -o jsonpath='{.items[0].status.loadBalancer.ingress[0].hostname}' 2>/dev/null || echo 'pending...')"
log "  TechDocs S3:    s3://${TECHDOCS_BUCKET}"
log "  ArgoCD:         $(kubectl get ingress argocd-server -n argocd -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || echo 'pending...')"
log "  KAgent UI:      $(kubectl get ingress kagent-ui -n kagent -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || echo 'not deployed (--skip-ai)')"
log "  MLflow:         $(kubectl get ingress mlflow -n ml-platform -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || echo 'not deployed (--skip-ai)')"
log ""
log "Next steps if GITHUB_TOKEN was not set:"
log "  1. aws secretsmanager update-secret --secret-id idp-mvp/backstage \\"
log "       --secret-string \"\$(aws secretsmanager get-secret-value --secret-id idp-mvp/backstage --query SecretString --output text | python3 -c \"import json,sys; s=json.load(sys.stdin); s['GITHUB_TOKEN']='<YOUR_TOKEN>'; print(json.dumps(s))\")\""
log "  2. kubectl rollout restart deployment/backstage -n backstage"
