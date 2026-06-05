#!/usr/bin/env bash
# bootstrap.sh — Provision the IDP MVP platform end-to-end on AWS EKS
# Usage: ./scripts/bootstrap.sh [--region us-east-1] [--cluster-name idp-mvp] [--skip-*]
# Includes: Terraform, EKS, Observability, ArgoCD, OPA, AI/ML platform, Argo Workflows
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
kubectl apply -f kubernetes/namespaces/services-quota.yaml
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
kubectl apply -f aws/backstage/db-init-sa.yaml
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
  --wait --timeout 10m

# ── Phase 3.6a: Create ClusterSecretStore (AWS Secrets Manager backend for ESO) ─
log "Phase 3.6a: Creating ClusterSecretStore for AWS Secrets Manager..."

# Wait for External Secrets Operator pods to be ready (critical timing fix)
log "  Waiting for External Secrets Operator pods to be ready..."
kubectl wait --for=condition=ready pod \
  -l app.kubernetes.io/name=external-secrets \
  -n external-secrets \
  --timeout=300s || log "  WARNING: ESO pods not ready — proceeding anyway"

# Annotate the ESO ServiceAccount with the Backstage IRSA role so it can
# authenticate to Secrets Manager via pod identity (no static credentials).
# The IAM trust policy references external-secrets-sa (not the default external-secrets SA).
# Create it if missing so the ClusterSecretStore IRSA authentication succeeds.
kubectl create serviceaccount external-secrets-sa -n external-secrets \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl annotate serviceaccount external-secrets-sa \
  -n external-secrets \
  "eks.amazonaws.com/role-arn=${BACKSTAGE_ROLE_ARN}" \
  --overwrite

# Substitute the AWS region placeholder and apply
sed "s/YOUR_AWS_REGION/${AWS_REGION}/g" aws/external-secrets/cluster-secret-store.yaml \
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
  kubectl apply -f aws/observability/dora/dora-cronjob.yaml
  kubectl annotate serviceaccount dora-exporter-sa \
    -n monitoring \
    "eks.amazonaws.com/role-arn=${DORA_ROLE_ARN}" \
    --overwrite
  kubectl create configmap dora-exporter-script \
    --from-file=dora-exporter.py=aws/observability/dora/dora-exporter.py \
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

  # Generate random tokens for Backstage session signing and external access.
  BACKSTAGE_CATALOG_TOKEN=$(openssl rand -hex 32 2>/dev/null || python3 -c "import secrets; print(secrets.token_hex(32))")
  AUTH_SESSION_SECRET=$(openssl rand -hex 32 2>/dev/null || python3 -c "import secrets; print(secrets.token_hex(32))")

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
# GitHub App credentials (replaces GH_PAT for Backstage scaffolder + auto-merge CI).
# Create at: github.com/settings/apps → New GitHub App. Permissions: Contents=Read,
# Pull requests=Write, Members=Read, Metadata=Read. Then install on platform repo.
for key in ('GITHUB_APP_ID','GITHUB_APP_CLIENT_ID','GITHUB_APP_CLIENT_SECRET',
            'GITHUB_APP_PRIVATE_KEY','GITHUB_APP_WEBHOOK_SECRET'):
    val = os.environ.get(key, '')
    if val:
        s[key] = val
# TEAM_MAP: optional JSON repo-to-team map. Falls back to team:<name> GitHub topic.
team_map = os.environ.get('TEAM_MAP', '')
if team_map:
    s['TEAM_MAP'] = team_map
s['BACKSTAGE_CATALOG_TOKEN'] = os.environ['BACKSTAGE_CATALOG_TOKEN']
s['AUTH_SESSION_SECRET'] = os.environ['AUTH_SESSION_SECRET']
print(json.dumps(s))
" K8S_SA_TOKEN="$K8S_SA_TOKEN" BACKSTAGE_CATALOG_TOKEN="$BACKSTAGE_CATALOG_TOKEN" AUTH_SESSION_SECRET="$AUTH_SESSION_SECRET")

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
kubectl apply -f kubernetes/monitoring/grafana-finops-dashboard-configmap.yaml
kubectl apply -f kubernetes/monitoring/grafana-sre-dashboard-configmap.yaml

# Substitute region and Grafana IRSA ARN placeholders in the values file
tmp_obs_values=$(mktemp /tmp/prometheus-stack-values-aws.XXXXXX.yaml)
sed \
  -e "s|YOUR_AWS_REGION|${AWS_REGION}|g" \
  -e "s|GRAFANA_IRSA_ROLE_ARN|${GRAFANA_ROLE_ARN}|g" \
  aws/observability/prometheus-stack-values.yaml > "${tmp_obs_values}"

helm upgrade --install prometheus prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --create-namespace \
  --values "${tmp_obs_values}" \
  --set grafana.adminPassword="${GRAFANA_ADMIN_PASSWORD:-changeme}" \
  --wait --timeout 10m
rm -f "${tmp_obs_values}"

kubectl apply -f observability/alertmanager/prometheus-rules.yaml
log "  PrometheusRules applied (SLO burn-rate, DORA anomalies, team budgets, KAgent guardrails)."

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
  --wait --timeout 5m

kubectl apply -f aws/monitoring/pushgateway-ingress.yaml
log "Pushgateway ALB ingress applied."

# Seed QA demo metrics so the Grafana QA Platform dashboard has data immediately
PUSHGATEWAY_INTERNAL="http://prometheus-pushgateway.monitoring.svc.cluster.local:9091"
PUSHGATEWAY_URL="${PUSHGATEWAY_INTERNAL}" bash scripts/seed-qa-metrics.sh \
  || log "  WARNING: QA metrics seed failed — run scripts/seed-qa-metrics.sh manually after deploy."

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
fi # --skip-policies

# ── Phase 3.9: Kyverno + team policies ───────────────────────────────────────
# Kyverno handles admission policies that require namespace-aware mutations
# (e.g. auto-injecting idp:team tag on Crossplane claims from team-* namespaces).
log "Phase 3.9: Installing Kyverno..."
helm repo add kyverno https://kyverno.github.io/kyverno/ 2>/dev/null || true
helm repo update kyverno
helm upgrade --install kyverno kyverno/kyverno \
  --namespace kyverno \
  --create-namespace \
  --version 3.2.7 \
  --set replicaCount=2 \
  --set resources.requests.cpu=100m \
  --set resources.requests.memory=256Mi \
  --wait --timeout 5m

kubectl wait deployment kyverno-admission-controller \
  -n kyverno --for=condition=Available --timeout=120s

kubectl apply -f kubernetes/policies/kyverno/team-quota-policy.yaml
kubectl apply -f kubernetes/policies/kyverno/crossplane-team-label-policy.yaml
log "  Phase 3.9 complete: Kyverno + team policies installed."

# ── Phase 4.4-pre: Argo Rollouts (progressive delivery) ─────────────────────
log "Phase 4.4-pre: Installing Argo Rollouts (canary deployments)..."
helm repo add argo https://argoproj.github.io/argo-helm 2>/dev/null || true
helm repo update argo

kubectl create namespace argo-rollouts --dry-run=client -o yaml | kubectl apply -f -

helm upgrade --install argo-rollouts argo/argo-rollouts \
  --namespace argo-rollouts \
  --values "${ROOT_DIR}/aws/argocd/argo-rollouts-values.yaml" \
  --wait --timeout 5m

kubectl apply -f "${ROOT_DIR}/kubernetes/argo-rollouts/analysis-template.yaml"
log "  Argo Rollouts installed. Services can opt into canary by setting rollout.enabled: true in their helm-values overlay."

# ── Phase 4.4-pre-b: Loki + Promtail (log aggregation) ───────────────────────
log "Phase 4.4-pre-b: Installing Loki + Promtail (log aggregation)..."
helm repo add grafana https://grafana.github.io/helm-charts 2>/dev/null || true
helm repo update grafana

helm upgrade --install loki grafana/loki \
  --namespace monitoring \
  --values "${ROOT_DIR}/aws/observability/loki/loki-values.yaml" \
  --set "loki.storage.s3.region=${AWS_REGION}" \
  --wait --timeout 8m || log "WARNING: Loki install had issues — check aws/observability/loki/loki-values.yaml (requires S3 bucket)"

helm upgrade --install promtail grafana/promtail \
  --namespace monitoring \
  --values "${ROOT_DIR}/aws/observability/loki/promtail-values.yaml" \
  --wait --timeout 3m
log "  Loki + Promtail installed. Logs available in Grafana → Explore → Loki datasource."

# ── Phase 4.4-pre-c: Grafana Tempo (distributed tracing) ─────────────────────
log "Phase 4.4-pre-c: Installing Grafana Tempo (distributed tracing)..."
helm upgrade --install tempo grafana/tempo-distributed \
  --namespace monitoring \
  --values "${ROOT_DIR}/aws/observability/tempo/tempo-values.yaml" \
  --set "storage.trace.s3.region=${AWS_REGION}" \
  --wait --timeout 8m || log "WARNING: Tempo install had issues — check aws/observability/tempo/tempo-values.yaml (requires S3 bucket)"
log "  Tempo installed. Traces available in Grafana → Explore → Tempo datasource."

# ── Phase 4.4: Tech Insights Exporter ────────────────────────────────────────
log "Phase 4.4: Deploying Tech Insights Exporter CronJob..."
kubectl create configmap tech-insights-exporter-script \
  --from-file=exporter.py=observability/tech-insights-exporter/exporter.py \
  -n monitoring --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f observability/tech-insights-exporter/cronjob.yaml
log "  Tech Insights Exporter deployed (pushes scorecard metrics to Pushgateway every 15m)."

# Deploy team budget ConfigMap so the exporter can reference it and AlertManager
# fires TeamBudgetWarning/TeamBudgetExceeded PrometheusRules correctly.
kubectl apply -f kubernetes/finops/team-budgets-configmap.yaml
log "  Team budget ConfigMap applied (monitoring/team-budgets)."

# ── Phase 4.4a2: Flaky-Test Exporter ─────────────────────────────────────────
log "Phase 4.4a2: Deploying Flaky-Test Exporter CronJob..."
GH_TOKEN_FOR_FLAKE="${GITHUB_TOKEN:-}"
if [[ -z "$GH_TOKEN_FOR_FLAKE" ]]; then
  log "  GITHUB_TOKEN not in env — fetching from Secrets Manager (key: github-token in idp-mvp/backstage)..."
  GH_TOKEN_FOR_FLAKE=$(aws secretsmanager get-secret-value \
    --secret-id idp-mvp/backstage --query SecretString --output text 2>/dev/null \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('GITHUB_TOKEN',''))" \
    2>/dev/null || echo "")
fi
if [[ -z "$GH_TOKEN_FOR_FLAKE" ]]; then
  log "  WARNING: no GITHUB_TOKEN available — Flaky-Test Exporter will skip every tick until you set it."
  GH_TOKEN_FOR_FLAKE="placeholder-set-via-secrets-manager"
fi
kubectl create secret generic flaky-test-exporter-github-token \
  --from-literal=token="$GH_TOKEN_FOR_FLAKE" \
  -n monitoring --dry-run=client -o yaml | kubectl apply -f -
kubectl create configmap flaky-test-exporter-script \
  --from-file=exporter.py=observability/flaky-test-exporter/exporter.py \
  -n monitoring --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f observability/flaky-test-exporter/cronjob.yaml
log "  Flaky-Test Exporter deployed (scans GitHub Actions artifacts every 30m)."

# ── Phase 4.4a: ServiceMonitor — Prometheus scraping for services namespaces ──
log "Phase 4.4a: Applying ServiceMonitor for services namespaces..."
kubectl apply -f kubernetes/monitoring/servicemonitor.yaml
log "  ServiceMonitor applied — Prometheus will scrape services/services-dev."

# ── Phase 4.4b: Demo team namespace (awesome-team) ───────────────────────────
log "Phase 4.4b: Applying demo team namespace (awesome-team)..."
kubectl apply -f kubernetes/teams/awesome-team/namespace.yaml
kubectl apply -f kubernetes/teams/awesome-team/rbac.yaml
kubectl apply -f kubernetes/teams/awesome-team/resource-quota.yaml
kubectl apply -f kubernetes/teams/awesome-team/limit-range.yaml
kubectl apply -f kubernetes/teams/awesome-team/network-policy.yaml
log "  Team namespace team-awesome-team ready (RBAC, quotas, network policies)."

# ── Phase 4.5: Install ArgoCD ────────────────────────────────────────────────
if [[ "$SKIP_GITOPS" != "true" ]]; then
log "Phase 4.5: Installing ArgoCD..."
helm repo add argo https://argoproj.github.io/argo-helm 2>/dev/null || true
helm repo update
helm upgrade --install argocd argo/argo-cd \
  --namespace argocd \
  --create-namespace \
  --values aws/argocd/argocd-helm-values.yaml \
  --wait \
  --timeout 5m

log "  ArgoCD installed."
ARGOCD_ADMIN_PASSWORD=$(kubectl get secret argocd-initial-admin-secret -n argocd \
  -o jsonpath='{.data.password}' | base64 --decode)
log "  ArgoCD admin password: ${ARGOCD_ADMIN_PASSWORD}"

# ── Phase 4.6: Apply the GitOps ApplicationSet ───────────────────────────────
log "Phase 4.6: Applying ArgoCD ApplicationSet (GitOps)..."
kubectl apply -f aws/argocd/app-of-apps.yaml -n argocd
log "  ApplicationSet applied — ArgoCD will sync services once image tags are set."

# ── Phase 4.6a: Crossplane stack ─────────────────────────────────────────────
# Substitute the IRSA role ARN (from Terraform output) into the provider
# runtime config, then hand the stack to ArgoCD. ArgoCD owns reconciliation
# from this point on; the substitution is a one-shot bootstrap step.
log "Phase 4.6a: Bootstrapping Crossplane..."
CROSSPLANE_ROLE_ARN=$(cd terraform && terraform output -raw crossplane_aws_role_arn 2>/dev/null || echo "")
if [[ -n "$CROSSPLANE_ROLE_ARN" ]]; then
  if [[ "$CROSSPLANE_ROLE_ARN" != arn:aws:iam::* ]]; then
    err "crossplane_aws_role_arn doesn't look like an IAM role ARN: '${CROSSPLANE_ROLE_ARN}'"
  fi
  log "  Substituting Crossplane IRSA role ARN into deployment-runtime-config..."
  sed "s|IRSA_ROLE_ARN|${CROSSPLANE_ROLE_ARN}|g" \
    aws/crossplane/providers/deployment-runtime-config.yaml \
    | kubectl apply -f -
  log "  Applying Crossplane stack (core + providers + compositions) via ArgoCD..."
  kubectl apply -f aws/argocd/crossplane.yaml
  log "  Crossplane Applications registered. Check: kubectl get providers.pkg.crossplane.io"
else
  log "  WARNING: crossplane_aws_role_arn not found in TF state — skipping Crossplane bootstrap."
  log "           Run 'terraform apply' first, then re-run this phase."
fi

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

# Write seed image tag into helm-values-aws.yaml so ArgoCD syncs immediately
IMAGE_REPO_ESC="${IMAGE_REPO}" IMAGE_TAG_ESC="${IMAGE_TAG}" python3 - <<'PYEOF'
import os, re
f = 'services/hello-service/helm-values-aws.yaml'
content = open(f).read()
content = re.sub(r'(repository:\s*)\S+', r'\g<1>' + os.environ['IMAGE_REPO_ESC'], content)
content = re.sub(r'(tag:\s*)\S+',        r'\g<1>' + os.environ['IMAGE_TAG_ESC'],  content)
open(f, 'w').write(content)
PYEOF
git config user.name  "idp-bot" 2>/dev/null || true
git config user.email "idp-bot@platform" 2>/dev/null || true
git add services/hello-service/helm-values-aws.yaml
git diff --staged --quiet || \
  git commit -m "chore(gitops): hello-service seed image ${IMAGE_TAG} [skip ci]" && \
  git push 2>/dev/null || log "  (git push skipped — not in a git repo or no remote)"

log "hello-service seed image pushed — ArgoCD will deploy to dev namespace."

# ── Phase 5.5: Build + push Backstage image ───────────────────────────────────
# The Backstage Dockerfile is multi-stage and runs yarn install + yarn build:backend
# inside the builder stage. No host-side yarn build is needed.
log "Phase 5.5: Building and pushing Backstage image..."
BACKSTAGE_IMAGE="${ECR_REGISTRY}/${CLUSTER_NAME}/backstage"

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
kubectl apply -f aws/backstage/external-secret.yaml

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

# Apply configmaps (base-config + production overrides) and deployment.
# Substitute the real ECR image into the deployment manifest before applying.
kubectl apply -f kubernetes/backstage/configmap.yaml
sed "s|image: .*backstage:latest|image: ${BACKSTAGE_IMAGE}:latest|g" \
  aws/backstage/deployment.yaml | kubectl apply -f -

# Wait for Backstage LB to get a hostname (up to 6 min)
log "  Waiting for Backstage LoadBalancer hostname..."
for i in $(seq 1 36); do
  BACKSTAGE_URL=$(kubectl get svc backstage -n backstage \
    -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || echo "")
  [[ -n "$BACKSTAGE_URL" ]] && break
  [[ $i -eq 36 ]] && { log "  LoadBalancer hostname not ready — skipping URL patch."; BACKSTAGE_URL="PENDING"; }
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

# ── Phase 5.8: AlertManager routing (Slack + PagerDuty) ─────────────────────
log "Phase 5.8: Wiring AlertManager Slack webhook..."
if [[ -n "${SLACK_WEBHOOK_URL:-}" ]]; then
  kubectl create secret generic alertmanager-slack-webhook \
    --from-literal=webhook-url="${SLACK_WEBHOOK_URL}" \
    -n monitoring --dry-run=client -o yaml | kubectl apply -f -
  kubectl apply -f observability/alertmanager/alertmanager-config.yaml
  log "  AlertManager Slack webhook configured."
else
  log "  SLACK_WEBHOOK_URL not set — skipping AlertManager Slack routing."
  log "  To enable: export SLACK_WEBHOOK_URL=https://hooks.slack.com/... and re-run."
fi

if [[ -n "${PAGERDUTY_INTEGRATION_KEY:-}" ]]; then
  kubectl create secret generic alertmanager-pagerduty \
    --from-literal=integration-key="${PAGERDUTY_INTEGRATION_KEY}" \
    -n monitoring --dry-run=client -o yaml | kubectl apply -f -
  log "  PagerDuty secret created — critical alerts will page on-call."
else
  log "  PAGERDUTY_INTEGRATION_KEY not set — PagerDuty on-call paging disabled."
  log "  To enable: export PAGERDUTY_INTEGRATION_KEY=<key> and re-run."
fi

# ── Phase 6: AI/ML platform (KAgent + MLflow + MCP servers) ──────────────────
if [[ "$SKIP_AI" != "true" ]]; then
  log "Phase 6: Deploying AI/ML platform..."
  cd "$ROOT_DIR"
  bash scripts/bootstrap-ai.sh --aws --region "${AWS_REGION}" --cluster "${CLUSTER_NAME}"
fi

# ── Phase 6a: Argo Workflows (optional, for ML pipeline orchestration) ──────────
if [[ "$SKIP_AI" != "true" ]]; then
  log "Phase 6a: Installing Argo Workflows for ML orchestration..."
  (
    set -e
    helm repo add argo https://argoproj.github.io/argo-helm 2>/dev/null || true
    helm repo update argo

    # Create S3 bucket for Argo artifacts if needed
    ARGO_BUCKET="argo-workflows-artifacts-${CLUSTER_NAME}"
    if ! aws s3 ls "s3://${ARGO_BUCKET}/" --region "${AWS_REGION}" &>/dev/null; then
      log "Creating S3 bucket for Argo Workflows artifacts..."
      aws s3 mb "s3://${ARGO_BUCKET}" --region "${AWS_REGION}" 2>/dev/null || true
    fi

    # Get the Argo Workflows IRSA role ARN from Terraform (if it exists)
    ARGO_ROLE_ARN=$(cd "${TF_DIR}" && terraform output -raw argo_workflows_role_arn 2>/dev/null || echo "")

    # Install Argo Workflows with AWS values
    VALUES_FILE="${ROOT_DIR}/aws/argo-workflows/values.yaml"
    sed "s|CLUSTER_NAME_PLACEHOLDER|${CLUSTER_NAME}|g; s|REGION_PLACEHOLDER|${AWS_REGION}|g; s|ARGO_WORKFLOWS_ROLE_ARN_PLACEHOLDER|${ARGO_ROLE_ARN}|g; s|BACKSTAGE_ALB_URL_PLACEHOLDER|${BACKSTAGE_URL}|g" \
      "$VALUES_FILE" > /tmp/argo-values-${CLUSTER_NAME}.yaml

    helm upgrade --install argo-workflows argo/argo-workflows \
      --namespace argo-workflows \
      --create-namespace \
      -f /tmp/argo-values-${CLUSTER_NAME}.yaml \
      --wait \
      --timeout 300s || log "WARNING: Argo Workflows Helm install had issues (non-critical for platform operation)"

    # Apply RBAC if ServiceAccount creation succeeded
    kubectl apply -f "${ROOT_DIR}/kubernetes/argo-workflows/rbac.yaml" 2>/dev/null || true

    log "Argo Workflows deployed — UI pending ALB provisioning"
  )
else
  log "Phase 6a: Skipping Argo Workflows (--skip-ai flag)"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
_alb() {
  # Usage: _alb <ingress-name> <namespace>
  kubectl get ingress "$1" -n "$2" \
    -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null \
    | grep -v '^$' || echo "pending..."
}

log ""
log "╔══════════════════════════════════════════════════════════════════════════════╗"
log "║                     Bootstrap complete — AWS platform URLs                  ║"
log "╠══════════════════════════════════════════════════════════════════════════════╣"
log "║  Cluster        $(kubectl config current-context)"
log "╠══════════════════════════════════════════════════════════════════════════════╣"
log "║  DEVELOPER PORTAL"
log "║    Backstage       http://${BACKSTAGE_URL:-PENDING}"
log "║    AI Assistant    http://${BACKSTAGE_URL:-PENDING}/ai-assistant"
log "╠══════════════════════════════════════════════════════════════════════════════╣"
log "║  PLATFORM SERVICES"
log "║    ArgoCD          http://$(_alb argocd-server argocd)"
log "║    Argo Rollouts   http://$(_alb argo-rollouts-dashboard argo-rollouts)"
log "║    Grafana         http://$(_alb grafana monitoring)"
log "║    Prometheus      http://$(_alb prometheus monitoring)"
log "║    AlertManager    http://$(_alb alertmanager monitoring)"
log "║    Pushgateway     http://$(_alb prometheus-pushgateway monitoring)"
log "║    OpenCost        http://$(_alb opencost-alb opencost)"
log "║    TechDocs S3     s3://${TECHDOCS_BUCKET}"
log "╠══════════════════════════════════════════════════════════════════════════════╣"
log "║  APPLICATION SERVICES"
log "║    hello-service   http://$(kubectl get svc hello-service -n services -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || echo 'pending...')"
log "╠══════════════════════════════════════════════════════════════════════════════╣"
if [[ "$SKIP_AI" != "true" ]]; then
log "║  AI/ML PLATFORM"
log "║    KAgent UI           http://$(_alb kagent-ui kagent)"
log "║    IDP Assistant (A2A) http://$(_alb idp-assistant kagent)"
log "║    MLflow              http://$(_alb mlflow ml-platform)"
log "║    Argo Workflows      http://$(_alb argo-workflows-server argo-workflows)"
log "║    IDP MCP Server      http://$(_alb idp-mcp-server services-dev)"
log "║    QA MCP Server       http://$(_alb qa-mcp-server services-dev)"
log "║    Contract MCP Server http://$(_alb contract-mcp-server services-dev)"
log "╠══════════════════════════════════════════════════════════════════════════════╣"
fi
log "╚══════════════════════════════════════════════════════════════════════════════╝"
log ""
if [[ "$BACKSTAGE_URL" == "PENDING" ]]; then
  log "⚠️  Backstage LoadBalancer hostname not ready. Run this to patch it later:"
  log "  BACKSTAGE_URL=\$(kubectl get svc backstage -n backstage -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')"
  log "  kubectl get configmap backstage-config -n backstage -o json | sed \"s|BACKSTAGE_ALB_URL|\${BACKSTAGE_URL}|g\" | kubectl apply -f -"
  log "  kubectl rollout restart deployment/backstage -n backstage"
  log ""
fi
log "Next steps if GITHUB_TOKEN was not set:"
log "  1. aws secretsmanager update-secret --secret-id idp-mvp/backstage \\"
log "       --secret-string \"\$(aws secretsmanager get-secret-value --secret-id idp-mvp/backstage --query SecretString --output text | python3 -c \"import json,sys; s=json.load(sys.stdin); s['GITHUB_TOKEN']='<YOUR_TOKEN>'; print(json.dumps(s))\")\""
log "  2. kubectl rollout restart deployment/backstage -n backstage"
