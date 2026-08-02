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

# shellcheck disable=SC1091
source "${ROOT_DIR}/scripts/lib.sh"

# Per-phase wall-clock timings, printed as a slowest-first table on exit
# (including on failure). IDP_TIMING=0 silences it; IDP_FORCE=1 bypasses every
# skip-if-unchanged check and reinstalls/rebuilds everything.
timer_enable_summary

SKIP_OBS="${SKIP_OBS:-false}"
SKIP_GITOPS="${SKIP_GITOPS:-false}"
SKIP_POLICIES="${SKIP_POLICIES:-false}"
SKIP_DORA="${SKIP_DORA:-false}"
SKIP_AI="${SKIP_AI:-false}"
SKIP_VELERO="${SKIP_VELERO:-false}"

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
    --skip-velero)   SKIP_VELERO=true; shift ;;
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
timer_start "1. Terraform (EKS/VPC/RDS/ECR/IAM)"
log "Phase 1: Provisioning infrastructure with Terraform..."

cd "$TF_DIR"
terraform init -upgrade
terraform apply -auto-approve \
  -var "aws_region=${AWS_REGION}" \
  -var "cluster_name=${CLUSTER_NAME}"

tf_outputs_load "$TF_DIR"
BACKSTAGE_SECRET_ARN=$(tf_output_required backstage_secret_arn)
TECHDOCS_BUCKET=$(tf_output_required techdocs_bucket_name)
BACKSTAGE_ROLE_ARN=$(tf_output_required backstage_role_arn)

log "Terraform apply complete."

timer_end "1. Terraform (EKS/VPC/RDS/ECR/IAM)"

# ── Phase 2: Configure kubectl ────────────────────────────────────────────────
timer_start "2. kubectl config"
log "Phase 2: Configuring kubectl..."
aws eks update-kubeconfig --region "${AWS_REGION}" --name "${CLUSTER_NAME}"
kubectl cluster-info

timer_end "2. kubectl config"

# ── Phase 3: Platform namespaces + RBAC ──────────────────────────────────────
timer_start "3. Namespaces + RBAC"
log "Phase 3: Creating namespaces and RBAC..."
cd "$ROOT_DIR"
kubectl apply -f kubernetes/namespaces/namespaces.yaml
kubectl apply -f kubernetes/namespaces/services-quota.yaml
kubectl apply -f kubernetes/rbac/github-actions.yaml
kubectl apply -f kubernetes/network-policies/default-deny.yaml

# ── Phase 3.5: Annotate backstage ServiceAccount with IRSA role ARN ──────────
log "Phase 3.5: Setting up Backstage ServiceAccount with IRSA..."
kubectl apply -f kubernetes/backstage/rbac.yaml
kubectl annotate serviceaccount backstage \
  -n backstage \
  "eks.amazonaws.com/role-arn=${BACKSTAGE_ROLE_ARN}" \
  --overwrite

# DB-init ServiceAccount (IRSA for Secrets Manager access)
DB_INIT_ROLE_ARN=$(tf_output_required db_init_role_arn)
kubectl apply -f aws/backstage/db-init-sa.yaml
kubectl annotate serviceaccount db-init-sa \
  -n services \
  "eks.amazonaws.com/role-arn=${DB_INIT_ROLE_ARN}" \
  --overwrite

# DORA exporter ServiceAccount IRSA annotation (applied after ESO installs the CRD)
DORA_ROLE_ARN=$(tf_output_required dora_exporter_role_arn)
kubectl create namespace monitoring --dry-run=client -o yaml | kubectl apply -f -

timer_end "3. Namespaces + RBAC"

# ── Phase 3.6: Install External Secrets Operator ─────────────────────────────
timer_start "3.6 External Secrets + secret store"
log "Phase 3.6: Installing External Secrets Operator..."
ensure_helm_repos external-secrets prometheus-community opencost gatekeeper kyverno argo grafana datadog vmware-tanzu
helm_upgrade_cached external-secrets external-secrets external-secrets/external-secrets \
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

timer_end "3.6 External Secrets + secret store"

# ── Phase 3.7: Populate Secrets Manager with runtime secrets ─────────────────
timer_start "3.7 Populate Secrets Manager"
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

  UPDATED_SECRET=$(echo "$CURRENT_SECRET" | K8S_SA_TOKEN="$K8S_SA_TOKEN" BACKSTAGE_CATALOG_TOKEN="$BACKSTAGE_CATALOG_TOKEN" AUTH_SESSION_SECRET="$AUTH_SESSION_SECRET" python3 -c "
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
")

  aws secretsmanager update-secret \
    --secret-id "$BACKSTAGE_SECRET_ARN" \
    --secret-string "$UPDATED_SECRET"
  log "  Secrets Manager updated with GITHUB_TOKEN + GitHub OAuth + Grafana credentials."
fi

timer_end "3.7 Populate Secrets Manager"

# ── Phase 4: Observability ────────────────────────────────────────────────────
timer_start "4. Prometheus + Grafana"
log "Phase 4: Installing observability stack (kube-prometheus-stack)..."

# The EBS CSI driver addon provisions volumes but doesn't create any StorageClass
# objects itself. aws/observability/prometheus-stack-values.yaml (and mlflow.yaml
# in bootstrap-ai.sh) both request storageClassName: gp3 — without this, the
# Prometheus StatefulSet never comes up (ReconciliationFailed: storage class "gp3"
# does not exist) and everything after it in this script hangs waiting on --wait.
kubectl apply -f - <<'EOF'
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
reclaimPolicy: Delete
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
EOF

# Grafana IRSA role ARN (injected into the Helm values via --set)
GRAFANA_ROLE_ARN=$(tf_output grafana_role_arn)

# Create Grafana dashboard ConfigMaps before installing the chart so that
# Grafana picks them up on first boot rather than requiring a pod restart.
# --from-file on a directory only picks up files directly inside it, not
# subdirectories — every dashboard JSON here lives one level deeper
# (dashboards/idp/*.json), so pointing at the parent dir silently produced an
# empty ConfigMap and the IDP Services dashboard never actually loaded.
kubectl create configmap grafana-dashboards-idp \
  --from-file=observability/grafana/dashboards/idp/ \
  -n monitoring --dry-run=client -o yaml | kubectl apply -f -

kubectl apply -f kubernetes/monitoring/grafana-dora-dashboard-configmap.yaml
kubectl apply -f kubernetes/monitoring/grafana-qa-dashboard-configmap.yaml
kubectl apply -f kubernetes/monitoring/grafana-finops-dashboard-configmap.yaml
kubectl apply -f kubernetes/monitoring/grafana-sre-dashboard-configmap.yaml
kubectl apply -f kubernetes/monitoring/grafana-ai-dashboard-configmap.yaml

# Substitute region and Grafana IRSA ARN placeholders in the values file
tmp_obs_values=$(mktemp /tmp/prometheus-stack-values-aws.XXXXXX)
sed \
  -e "s|YOUR_AWS_REGION|${AWS_REGION}|g" \
  -e "s|GRAFANA_IRSA_ROLE_ARN|${GRAFANA_ROLE_ARN}|g" \
  aws/observability/prometheus-stack-values.yaml > "${tmp_obs_values}"

# TLS on the Grafana/Prometheus/Alertmanager ALB ingresses (#141) — opt-in: only
# wired up when var.domain_name was set, since it needs the ACM cert terraform/acm.tf
# provisions from that domain's Route 53 zone. ALB terminates TLS from an ACM cert
# ARN (not a k8s TLS Secret), so ingresses without a domain stay HTTP-only exactly
# as before rather than risk an invalid empty certificate-arn breaking the ALB.
ACM_CERT_ARN=$(tf_output monitoring_acm_certificate_arn)
if [[ -n "${ACM_CERT_ARN}" ]]; then
  log "  Wiring ACM cert into monitoring ALB ingresses: ${ACM_CERT_ARN}"
  sed -i.bak \
    "s|alb.ingress.kubernetes.io/backend-protocol: HTTP|alb.ingress.kubernetes.io/backend-protocol: HTTP\n      alb.ingress.kubernetes.io/certificate-arn: ${ACM_CERT_ARN}\n      alb.ingress.kubernetes.io/listen-ports: '[{\"HTTP\":80},{\"HTTPS\":443}]'\n      alb.ingress.kubernetes.io/ssl-redirect: \"443\"|g" \
    "${tmp_obs_values}"
  rm -f "${tmp_obs_values}.bak"
else
  log "  No domain_name configured — monitoring ALB ingresses stay HTTP-only."
fi

# The Thanos sidecar block in prometheus-stack-values.yaml is V2 multi-region only
# (it's shared with bootstrap-multiregion.sh) — its objectStorageConfig secret is
# only ever created by terraform/global/thanos-config.tf, which this single-region
# script never runs. Disable it here so single-region Prometheus doesn't wait
# forever on a secret that will never exist in this deployment mode.

# grafana.sidecar.datasources.defaultDatasourceEnabled=false in the shared values
# file assumes aws/observability/grafana-multi-region-datasources.yaml replaces
# the chart's auto-provisioned Prometheus datasource — but that file is only ever
# applied by bootstrap-multiregion.sh. Without it, single-region Grafana ends up
# with zero datasources. Re-enable the chart default here.
helm_upgrade_cached prometheus monitoring prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --create-namespace \
  --values "${tmp_obs_values}" \
  --set grafana.adminPassword="${GRAFANA_ADMIN_PASSWORD:-changeme}" \
  --set prometheus.prometheusSpec.thanos=null \
  --set grafana.sidecar.datasources.defaultDatasourceEnabled=true \
  --wait --timeout 10m
rm -f "${tmp_obs_values}"

kubectl apply -f observability/alertmanager/prometheus-rules.yaml
log "  PrometheusRules applied (SLO burn-rate, DORA anomalies, team budgets, KAgent guardrails)."

timer_end "4. Prometheus + Grafana"

# ── Phase 4a: Prometheus Pushgateway ─────────────────────────────────────────
timer_start "4a. Pushgateway"
log "Phase 4a: Installing Prometheus Pushgateway..."
helm_upgrade_cached prometheus-pushgateway monitoring prometheus-community/prometheus-pushgateway \
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

timer_end "4a. Pushgateway"

# ── Phase 4b: OpenCost ────────────────────────────────────────────────────────
timer_start "4b. OpenCost"
log "Phase 4b: Installing OpenCost (cluster cost visibility)..."

kubectl apply -f kubernetes/finops/opencost.yaml

helm_upgrade_cached opencost opencost opencost/opencost \
  --namespace opencost \
  --set opencost.prometheus.internal.enabled=false \
  --set opencost.prometheus.external.enabled=true \
  --set "opencost.prometheus.external.url=http://prometheus-operated.monitoring.svc.cluster.local:9090" \
  --set opencost.exporter.defaultClusterId="${CLUSTER_NAME}" \
  --wait --timeout 5m

log "OpenCost installed."

timer_end "4b. OpenCost"

# ── Phase 3.8/3.9: OPA/Gatekeeper + Kyverno ──────────────────────────────────
timer_start "3.8-3.9 Gatekeeper + Kyverno (parallel)"
# Two independent policy engines (different namespaces/CRDs, neither reads a
# resource the other creates) — run as background jobs and joined below
# instead of one after another. Both _bg_join calls block until each job
# (including its own internal CRD/webhook-ready wait) finishes, so downstream
# phases still only start once both are fully up, matching today's ordering.
if [[ "$SKIP_POLICIES" != "true" ]]; then
  _p38_log=$(mktemp)
  (
    set -e
    log "Phase 3.8: Installing OPA/Gatekeeper policy engine..."
    helm_upgrade_cached gatekeeper gatekeeper-system gatekeeper/gatekeeper \
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
  ) > "$_p38_log" 2>&1 &
  _p38_pid=$!
else
  _p38_pid=""
fi # --skip-policies

# Kyverno handles admission policies that require namespace-aware mutations
# (e.g. auto-injecting idp:team tag on Crossplane claims from team-* namespaces).
# Unlike Gatekeeper above, this phase is NOT gated by --skip-policies (matches
# original behavior — always installs).
_p39_log=$(mktemp)
(
  set -e
  log "Phase 3.9: Installing Kyverno..."
  # Chart 3.2.7's default cleanup-job image is bitnami/kubectl:1.28.5, which 404s —
  # Bitnami's 2025 image-policy change moved older versioned tags to the
  # bitnamilegacy/* org (docker.io/bitnami/kubectl now only carries `latest` and
  # digest tags). Do NOT override with registry.k8s.io/kubectl instead: that image
  # has no shell (Kyverno's job templates invoke /bin/bash directly) and runs as
  # root, which the CronJob-based cleanup jobs' runAsNonRoot requirement rejects.
  # bitnamilegacy/kubectl keeps the same non-root default and has a real shell.
  helm_upgrade_cached kyverno kyverno kyverno/kyverno \
    --namespace kyverno \
    --create-namespace \
    --version 3.2.7 \
    --set replicaCount=2 \
    --set cleanupJobs.admissionReports.image.registry=docker.io \
    --set cleanupJobs.admissionReports.image.repository=bitnamilegacy/kubectl \
    --set cleanupJobs.admissionReports.image.tag=1.28.5 \
    --set cleanupJobs.clusterAdmissionReports.image.registry=docker.io \
    --set cleanupJobs.clusterAdmissionReports.image.repository=bitnamilegacy/kubectl \
    --set cleanupJobs.clusterAdmissionReports.image.tag=1.28.5 \
    --set cleanupJobs.ephemeralReports.image.registry=docker.io \
    --set cleanupJobs.ephemeralReports.image.repository=bitnamilegacy/kubectl \
    --set cleanupJobs.ephemeralReports.image.tag=1.28.5 \
    --set cleanupJobs.clusterEphemeralReports.image.registry=docker.io \
    --set cleanupJobs.clusterEphemeralReports.image.repository=bitnamilegacy/kubectl \
    --set cleanupJobs.clusterEphemeralReports.image.tag=1.28.5 \
    --set policyReportsCleanup.image.registry=docker.io \
    --set policyReportsCleanup.image.repository=bitnamilegacy/kubectl \
    --set policyReportsCleanup.image.tag=1.28.5 \
    --set webhooksCleanup.image.registry=docker.io \
    --set webhooksCleanup.image.repository=bitnamilegacy/kubectl \
    --set webhooksCleanup.image.tag=1.28.5 \
    --set resources.requests.cpu=100m \
    --set resources.requests.memory=256Mi \
    --wait --timeout 5m

  kubectl wait deployment kyverno-admission-controller \
    -n kyverno --for=condition=Available --timeout=120s
  wait_kyverno_webhook_ready

  kubectl apply -f kubernetes/policies/kyverno/team-quota-policy.yaml
  # crossplane-team-label-policy.yaml validates against Crossplane CRD kinds (e.g.
  # S3Bucket) that don't exist yet — Crossplane itself isn't bootstrapped until
  # Phase 4.6a, and even then ArgoCD syncs its CRDs asynchronously. Don't let a
  # not-yet-registered CRD kill the whole script; this policy can be (re-)applied
  # any time after Crossplane's CRDs exist.
  kubectl apply -f kubernetes/policies/kyverno/crossplane-team-label-policy.yaml || \
    log "  WARNING: crossplane-team-label-policy not applied yet (Crossplane CRDs not registered). Re-apply after Phase 4.6a: kubectl apply -f kubernetes/policies/kyverno/crossplane-team-label-policy.yaml"
  log "  Phase 3.9 complete: Kyverno + team policies installed."
) > "$_p39_log" 2>&1 &
_p39_pid=$!

_p389_fail=0
_bg_join "$_p38_pid" "$_p38_log" || { warn "Phase 3.8 (OPA/Gatekeeper) failed"; _p389_fail=1; }
_bg_join "$_p39_pid" "$_p39_log" || { warn "Phase 3.9 (Kyverno) failed"; _p389_fail=1; }
(( _p389_fail == 0 )) || err "Phase 3.8/3.9 (policy engines) failed — see output above."

timer_end "3.8-3.9 Gatekeeper + Kyverno (parallel)"

# ── Phase 4.4-pre/b/c/d: Argo Rollouts, Loki+Promtail, Tempo, Datadog ────────
timer_start "4.4x Rollouts/Loki/Tempo/Datadog (parallel)"
# Four independent installs (different charts/namespaces) that only depend on
# Phase 4's kube-prometheus-stack already being up, which ran well before this
# point — run as background jobs and joined below instead of one after
# another. Loki/Tempo/Datadog already tolerate their own helm failures via
# `|| log "WARNING: ..."` (so they rarely propagate a failure at all); Argo
# Rollouts didn't have that guard before, so all four are still waited on and
# aggregated into a single err() call if any truly fails, matching the
# original fail-fast behavior for Argo Rollouts without exiting mid-loop and
# leaving the other jobs running detached.
_p44pre_log=$(mktemp); _p44preb_log=$(mktemp); _p44prec_log=$(mktemp); _p44pred_log=$(mktemp)

(
  set -e
  log "Phase 4.4-pre: Installing Argo Rollouts (canary deployments)..."
  kubectl create namespace argo-rollouts --dry-run=client -o yaml | kubectl apply -f -
  helm_upgrade_cached argo-rollouts argo-rollouts argo/argo-rollouts \
    --namespace argo-rollouts \
    --values "${ROOT_DIR}/aws/argocd/argo-rollouts-values.yaml" \
    --wait --timeout 5m
  kubectl apply -f "${ROOT_DIR}/kubernetes/argo-rollouts/analysis-template.yaml"
  log "  Argo Rollouts installed. Services can opt into canary by setting rollout.enabled: true in their helm-values overlay."
) > "$_p44pre_log" 2>&1 &
_p44pre_pid=$!

(
  set -e
  log "Phase 4.4-pre-b: Installing Loki + Promtail (log aggregation)..."
  LOKI_BUCKET=$(tf_output loki_chunks_bucket_name)
  LOKI_ROLE_ARN=$(tf_output loki_role_arn)
  [[ -n "$LOKI_BUCKET" ]] || log "  WARNING: loki_chunks_bucket_name not found in Terraform outputs — Loki will fail to start."

  helm_upgrade_cached loki monitoring grafana/loki \
    --namespace monitoring \
    --values "${ROOT_DIR}/aws/observability/loki/loki-values.yaml" \
    --set "loki.storage.bucketNames.chunks=${LOKI_BUCKET}" \
    --set "loki.storage.bucketNames.ruler=${LOKI_BUCKET}" \
    --set "loki.storage.s3.region=${AWS_REGION}" \
    --set "serviceAccount.annotations.eks\.amazonaws\.com/role-arn=${LOKI_ROLE_ARN}" \
    --wait --timeout 8m || log "WARNING: Loki install had issues — check aws/observability/loki/loki-values.yaml (requires S3 bucket)"

  helm_upgrade_cached promtail monitoring grafana/promtail \
    --namespace monitoring \
    --values "${ROOT_DIR}/aws/observability/loki/promtail-values.yaml" \
    --wait --timeout 3m || log "WARNING: Promtail install had issues — non-fatal, log shipping just won't be active yet."
  log "  Loki + Promtail installed. Logs available in Grafana → Explore → Loki datasource."
) > "$_p44preb_log" 2>&1 &
_p44preb_pid=$!

(
  set -e
  log "Phase 4.4-pre-c: Installing Grafana Tempo (distributed tracing)..."
  TEMPO_BUCKET=$(tf_output tempo_traces_bucket_name)
  TEMPO_ROLE_ARN=$(tf_output tempo_role_arn)
  [[ -n "$TEMPO_BUCKET" ]] || log "  WARNING: tempo_traces_bucket_name not found in Terraform outputs — Tempo will fail to start."

  helm_upgrade_cached tempo monitoring grafana/tempo-distributed \
    --namespace monitoring \
    --values "${ROOT_DIR}/aws/observability/tempo/tempo-values.yaml" \
    --set "storage.trace.s3.bucket=${TEMPO_BUCKET}" \
    --set "storage.trace.s3.region=${AWS_REGION}" \
    --set "serviceAccount.annotations.eks\.amazonaws\.com/role-arn=${TEMPO_ROLE_ARN}" \
    --wait --timeout 8m || log "WARNING: Tempo install had issues — check aws/observability/tempo/tempo-values.yaml (requires S3 bucket)"
  log "  Tempo installed. Traces available in Grafana → Explore → Tempo datasource."
) > "$_p44prec_log" 2>&1 &
_p44prec_pid=$!

(
  set -e
  # Independent of Prometheus/Grafana/Loki/Tempo — see docs/sre-reliability.md
  # "Datadog Infra Observability & APM" for why the two collection domains are kept
  # separate. Requires datadog_api_key/datadog_app_key to be set in terraform.tfvars.
  log "Phase 4.4-pre-d: Installing Datadog Agent (infra + APM observability)..."
  kubectl create namespace datadog --dry-run=client -o yaml | kubectl apply -f -

  DATADOG_ESO_ROLE_ARN=$(tf_output datadog_eso_role_arn)
  if [[ -n "$DATADOG_ESO_ROLE_ARN" ]]; then
    sed "s|AWS_REGION_PLACEHOLDER|${AWS_REGION}|g" \
      "${ROOT_DIR}/aws/observability/datadog/datadog-external-secret.yaml" | kubectl apply -f -
    kubectl annotate serviceaccount datadog-eso-sa -n datadog \
      "eks.amazonaws.com/role-arn=${DATADOG_ESO_ROLE_ARN}" \
      --overwrite

    helm_upgrade_cached datadog datadog datadog/datadog \
      --namespace datadog \
      --values "${ROOT_DIR}/aws/observability/datadog/datadog-agent-values.yaml" \
      --wait --timeout 5m || log "WARNING: Datadog Agent install had issues — check that datadog-secrets synced (kubectl get externalsecret -n datadog) and aws/observability/datadog/datadog-agent-values.yaml"
    log "  Datadog Agent installed. Infra metrics/logs available in Datadog → Infrastructure; APM traces (including the Backstage backend) under Datadog → APM → Services."
  else
    log "  WARNING: datadog_eso_role_arn not found in Terraform outputs — skipping Datadog Agent install."
    log "           Set datadog_api_key/datadog_app_key in terraform.tfvars, run 'terraform apply' in ${TF_DIR}, then re-run this phase manually:"
    log "             kubectl create namespace datadog --dry-run=client -o yaml | kubectl apply -f -"
    log "             sed \"s|AWS_REGION_PLACEHOLDER|${AWS_REGION}|g\" aws/observability/datadog/datadog-external-secret.yaml | kubectl apply -f -"
    log "             kubectl annotate serviceaccount datadog-eso-sa -n datadog eks.amazonaws.com/role-arn=\$(tf_output datadog_eso_role_arn) --overwrite"
    log "             helm upgrade --install datadog datadog/datadog --namespace datadog --values aws/observability/datadog/datadog-agent-values.yaml"
  fi
) > "$_p44pred_log" 2>&1 &
_p44pred_pid=$!

_p44pre_fail=0
_bg_join "$_p44pre_pid"  "$_p44pre_log"  || { warn "Phase 4.4-pre (Argo Rollouts) failed"; _p44pre_fail=1; }
_bg_join "$_p44preb_pid" "$_p44preb_log" || { warn "Phase 4.4-pre-b (Loki + Promtail) failed"; _p44pre_fail=1; }
_bg_join "$_p44prec_pid" "$_p44prec_log" || { warn "Phase 4.4-pre-c (Tempo) failed"; _p44pre_fail=1; }
_bg_join "$_p44pred_pid" "$_p44pred_log" || { warn "Phase 4.4-pre-d (Datadog) failed"; _p44pre_fail=1; }
(( _p44pre_fail == 0 )) || err "Phase 4.4-pre/b/c/d (Argo Rollouts/Loki/Tempo/Datadog) failed — see output above."

timer_end "4.4x Rollouts/Loki/Tempo/Datadog (parallel)"

# ── Phase 4.4/4.4a2/4.4a/4.4b: independent CronJob/manifest applies ─────────
timer_start "4.4 Exporters (parallel)"
# None of these read state written by another, so they run as background jobs
# and are joined below instead of one after another. All four are waited on
# first, then aggregated into a single err() call if any failed — matching
# this script's top-level `set -euo pipefail` semantics that background jobs
# don't propagate automatically, without exiting mid-loop and leaving the
# other jobs running detached.
_p44_log=$(mktemp); _p44a2_log=$(mktemp); _p44a_log=$(mktemp); _p44b_log=$(mktemp)

(
  set -e
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
) > "$_p44_log" 2>&1 &
_p44_pid=$!

(
  set -e
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
    --from-file=quarantine.py=observability/flaky-test-exporter/quarantine.py \
    -n monitoring --dry-run=client -o yaml | kubectl apply -f -
  kubectl apply -f observability/flaky-test-exporter/cronjob.yaml
  kubectl apply -f observability/flaky-test-exporter/quarantine-cronjob.yaml
  log "  Flaky-Test Exporter deployed (scans GitHub Actions artifacts every 30m)."
  log "  Flaky-Test Quarantine Sync deployed (opens quarantine PRs daily at 06:00)."
) > "$_p44a2_log" 2>&1 &
_p44a2_pid=$!

(
  set -e
  log "Phase 4.4a: Applying ServiceMonitor for services namespaces..."
  kubectl apply -f kubernetes/monitoring/servicemonitor.yaml
  log "  ServiceMonitor applied — Prometheus will scrape services/services-dev."
) > "$_p44a_log" 2>&1 &
_p44a_pid=$!

(
  set -e
  log "Phase 4.4b: Applying demo team namespace (awesome-team)..."
  kubectl apply -f kubernetes/teams/awesome-team/namespace.yaml
  kubectl apply -f kubernetes/teams/awesome-team/rbac.yaml
  kubectl apply -f kubernetes/teams/awesome-team/resource-quota.yaml
  kubectl apply -f kubernetes/teams/awesome-team/limit-range.yaml
  kubectl apply -f kubernetes/teams/awesome-team/network-policy.yaml
  log "  Team namespace team-awesome-team ready (RBAC, quotas, network policies)."
) > "$_p44b_log" 2>&1 &
_p44b_pid=$!

_p44_fail=0
_bg_join "$_p44_pid"   "$_p44_log"   || { warn "Phase 4.4 (Tech Insights Exporter) failed";  _p44_fail=1; }
_bg_join "$_p44a2_pid" "$_p44a2_log" || { warn "Phase 4.4a2 (Flaky-Test Exporter) failed";    _p44_fail=1; }
_bg_join "$_p44a_pid"  "$_p44a_log"  || { warn "Phase 4.4a (ServiceMonitor) failed";          _p44_fail=1; }
_bg_join "$_p44b_pid"  "$_p44b_log"  || { warn "Phase 4.4b (demo team namespace) failed";     _p44_fail=1; }
(( _p44_fail == 0 )) || err "One or more of Phase 4.4/4.4a2/4.4a/4.4b failed — see output above."

timer_end "4.4 Exporters (parallel)"

# ── Phase 4.5: Install ArgoCD ────────────────────────────────────────────────
timer_start "4.5 ArgoCD"
if [[ "$SKIP_GITOPS" != "true" ]]; then
log "Phase 4.5: Installing ArgoCD..."
helm_upgrade_cached argocd argocd argo/argo-cd \
  --namespace argocd \
  --create-namespace \
  --values aws/argocd/argocd-helm-values.yaml \
  --wait \
  --timeout 5m

log "  ArgoCD installed."

# argocd-helm-values.yaml sets server.ingress.hosts: [] intending "match any
# hostname via ALB DNS", but the argo-cd chart still renders a default
# "argocd.example.com" host rule on the Ingress even with an empty hosts list —
# ALB only routes requests whose Host header matches a rule, so hitting the
# raw ALB hostname 404s until that placeholder host is removed.
kubectl patch ingress argocd-server -n argocd --type=json \
  -p='[{"op": "remove", "path": "/spec/rules/0/host"}]' 2>/dev/null \
  || log "  WARNING: could not remove ArgoCD ingress placeholder host — check manually if the ALB URL 404s."

ARGOCD_ADMIN_PASSWORD=$(kubectl get secret argocd-initial-admin-secret -n argocd \
  -o jsonpath='{.data.password}' | base64 --decode)
log "  ArgoCD admin password: ${ARGOCD_ADMIN_PASSWORD}"

timer_end "4.5 ArgoCD"

# ── Phase 4.6: Apply the GitOps ApplicationSet ───────────────────────────────
timer_start "4.6 ApplicationSet + Crossplane"
log "Phase 4.6: Applying ArgoCD ApplicationSet (GitOps)..."
kubectl apply -f aws/argocd/app-of-apps.yaml -n argocd
log "  ApplicationSet applied — ArgoCD will sync services once image tags are set."

# ── Phase 4.6a: Crossplane stack ─────────────────────────────────────────────
# Substitute the IRSA role ARN (from Terraform output) into the provider
# runtime config, then hand the stack to ArgoCD. ArgoCD owns reconciliation
# from this point on; the substitution is a one-shot bootstrap step.
log "Phase 4.6a: Bootstrapping Crossplane..."
CROSSPLANE_ROLE_ARN=$(tf_output crossplane_aws_role_arn)
if [[ -n "$CROSSPLANE_ROLE_ARN" ]]; then
  if [[ "$CROSSPLANE_ROLE_ARN" != arn:aws:iam::* ]]; then
    err "crossplane_aws_role_arn doesn't look like an IAM role ARN: '${CROSSPLANE_ROLE_ARN}'"
  fi
  log "  Applying Crossplane stack (core + providers + compositions) via ArgoCD..."
  kubectl apply -f aws/argocd/crossplane.yaml
  log "  Crossplane Applications registered. Check: kubectl get providers.pkg.crossplane.io"
  # deployment-runtime-config.yaml uses the DeploymentRuntimeConfig CRD, which
  # only exists once ArgoCD has synced Crossplane core (just triggered above,
  # asynchronously) — wait for it rather than applying blind, and don't let a
  # slow ArgoCD sync kill the rest of bootstrap; this substitution can be
  # re-run any time once Crossplane is up.
  log "  Waiting for Crossplane's DeploymentRuntimeConfig CRD (ArgoCD sync in progress)..."
  if kubectl wait --for=condition=established --timeout=180s \
      crd/deploymentruntimeconfigs.pkg.crossplane.io 2>/dev/null; then
    log "  Substituting Crossplane IRSA role ARN into deployment-runtime-config..."
    sed "s|IRSA_ROLE_ARN|${CROSSPLANE_ROLE_ARN}|g" \
      aws/crossplane/providers/deployment-runtime-config.yaml \
      | kubectl apply -f -
  else
    log "  WARNING: DeploymentRuntimeConfig CRD not ready yet — Crossplane core is still syncing via ArgoCD."
    log "           Re-run once ready: sed \"s|IRSA_ROLE_ARN|${CROSSPLANE_ROLE_ARN}|g\" aws/crossplane/providers/deployment-runtime-config.yaml | kubectl apply -f -"
  fi
else
  log "  WARNING: crossplane_aws_role_arn not found in TF state — skipping Crossplane bootstrap."
  log "           Run 'terraform apply' first, then re-run this phase."
fi

timer_end "4.6 ApplicationSet + Crossplane"

# ── Phase 4.7: Create Backstage read-only API token for ArgoCD plugin ────────
timer_start "4.7 Backstage/ArgoCD tokens"
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
      UPDATED_SECRET=$(echo "$CURRENT_SECRET" | ARGOCD_URL="$ARGOCD_URL" BACKSTAGE_ARGOCD_TOKEN="$BACKSTAGE_ARGOCD_TOKEN" python3 -c "
import json, sys, os
s = json.load(sys.stdin)
s['ARGOCD_URL'] = 'https://' + os.environ['ARGOCD_URL']
s['ARGOCD_AUTH_TOKEN'] = os.environ['BACKSTAGE_ARGOCD_TOKEN']
print(json.dumps(s))
")
      aws secretsmanager update-secret \
        --secret-id "$BACKSTAGE_SECRET_ARN" \
        --secret-string "$UPDATED_SECRET"
      log "  ArgoCD token stored in Secrets Manager."
    fi
  fi
fi
fi # --skip-gitops

timer_end "4.7 Backstage/ArgoCD tokens"

# ── Phase 5: Build + push hello-service seed image ───────────────────────────
timer_start "5. hello-service image"
# CI (GitHub Actions) manages ongoing deployments via GitOps (update-image-tag job).
# This phase seeds the initial image so ArgoCD has something to deploy on first run.
log "Phase 5: Building and pushing hello-service seed image..."
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_REGISTRY="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
IMAGE_REPO="${ECR_REGISTRY}/${CLUSTER_NAME}/hello-service"
IMAGE_TAG="$(git rev-parse --short HEAD 2>/dev/null || echo 'bootstrap')"

aws ecr get-login-password --region "${AWS_REGION}" | \
  docker login --username AWS --password-stdin "${ECR_REGISTRY}"

# Skip when the source and tag are unchanged and the tag is already in ECR.
# The build itself now reuses an ECR-side layer cache — see
# docker_build_push_amd64 in lib.sh for why that matters so much here.
_hello_fp_file="${ROOT_DIR}/.idp-cache/aws-image-hello-service.fingerprint"
_hello_fp="$(dir_content_hash "${ROOT_DIR}/services/hello-service"):${IMAGE_TAG}"
if [[ "${IDP_FORCE:-0}" != "1" ]] && image_unchanged "$_hello_fp_file" "$_hello_fp" \
     "aws ecr describe-images --region ${AWS_REGION} --repository-name ${CLUSTER_NAME}/hello-service --image-ids imageTag=${IMAGE_TAG}"; then
  log "  hello-service unchanged and ${IMAGE_TAG} already in ECR — skipping build."
else
  docker_build_push_amd64 services/hello-service "${IMAGE_REPO}" \
    --build-arg VERSION="${IMAGE_TAG}" \
    -t "${IMAGE_REPO}:${IMAGE_TAG}" \
    -t "${IMAGE_REPO}:latest"
  helm_record_fingerprint "$_hello_fp_file" "$_hello_fp"
fi

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

timer_end "5. hello-service image"

# ── Phase 5.5: Build + push Backstage image ───────────────────────────────────
timer_start "5.5 Backstage image"
# The Backstage Dockerfile is multi-stage and runs yarn install + yarn build:backend
# inside the builder stage. No host-side yarn build is needed.
# Tagged with the git SHA (not :latest) so the deployment manifest pins an immutable
# image — required by the repo's own OPA deny-latest-tag policy.
log "Phase 5.5: Building and pushing Backstage image..."
BACKSTAGE_IMAGE="${ECR_REGISTRY}/${CLUSTER_NAME}/backstage"
BACKSTAGE_IMAGE_TAG="$(git rev-parse --short HEAD 2>/dev/null || echo 'bootstrap')"

# This is the single most expensive build in the whole bootstrap: multi-stage,
# runs yarn install + yarn build:backend inside the builder, and does it all
# under amd64 emulation on an Apple-Silicon host. The ECR layer cache means a
# rebuild after an unrelated change reuses the yarn-install layers instead of
# re-running them emulated. Fingerprint covers the app source and the Dockerfile.
_bs_fp_file="${ROOT_DIR}/.idp-cache/aws-image-backstage.fingerprint"
_bs_fp="$(dir_content_hash "${ROOT_DIR}/backstage/app"):$(_sha256 "${ROOT_DIR}/backstage/Dockerfile"):${BACKSTAGE_IMAGE_TAG}"
if [[ "${IDP_FORCE:-0}" != "1" ]] && image_unchanged "$_bs_fp_file" "$_bs_fp" \
     "aws ecr describe-images --region ${AWS_REGION} --repository-name ${CLUSTER_NAME}/backstage --image-ids imageTag=${BACKSTAGE_IMAGE_TAG}"; then
  log "  Backstage unchanged and ${BACKSTAGE_IMAGE_TAG} already in ECR — skipping build."
else
  docker_build_push_amd64 backstage/app/ "${BACKSTAGE_IMAGE}" \
    -f backstage/Dockerfile \
    -t "${BACKSTAGE_IMAGE}:${BACKSTAGE_IMAGE_TAG}"
  helm_record_fingerprint "$_bs_fp_file" "$_bs_fp"
fi
log "Backstage image pushed to ECR: ${BACKSTAGE_IMAGE}:${BACKSTAGE_IMAGE_TAG}"

timer_end "5.5 Backstage image"

# ── Phase 5.6: Deploy Backstage ───────────────────────────────────────────────
timer_start "5.6 Deploy Backstage"
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

# Fetch the RDS combined CA bundle so Postgres connections can verify the server
# cert (rejectUnauthorized: true in app-config.aws.yaml) instead of skipping validation.
log "  Fetching RDS CA bundle..."
RDS_CA_BUNDLE="$(mktemp)"
curl -sSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o "${RDS_CA_BUNDLE}"
kubectl create configmap rds-ca-bundle -n backstage \
  --from-file=global-bundle.pem="${RDS_CA_BUNDLE}" \
  --dry-run=client -o yaml | kubectl apply -f -
rm -f "${RDS_CA_BUNDLE}"

# Apply configmaps (base-config + production overrides) and deployment.
# Substitute the real ECR image (pinned to the SHA tag just pushed) into the
# deployment manifest before applying.
kubectl apply -f kubernetes/backstage/configmap.yaml
sed "s|image: .*backstage:BACKSTAGE_IMAGE_TAG|image: ${BACKSTAGE_IMAGE}:${BACKSTAGE_IMAGE_TAG}|g" \
  aws/backstage/deployment.yaml | kubectl apply -f -

# Wait for the Backstage, ArgoCD and Grafana load balancers to be assigned
# hostnames. These three provision concurrently in AWS and nothing here depends
# on another, but they used to be polled in two back-to-back loops — 6 minutes
# of Backstage polling and only then up to 4 more for ArgoCD/Grafana, so a slow
# ALB could cost 10 minutes of pure waiting. One loop polls all three and stops
# as soon as all are up, bounding the whole thing at 6 minutes.
#
# ArgoCD and Grafana Ingresses are created earlier (Phase 4 / 4.5) so they are
# usually already assigned by the time we get here. KAgent's ALB isn't up yet
# (Phase 6 runs after this) — its URL is patched separately in bootstrap-ai.sh.
log "  Waiting for Backstage / ArgoCD / Grafana LoadBalancer hostnames..."
BACKSTAGE_URL=""
ARGOCD_URL=""
GRAFANA_URL=""
for i in $(seq 1 36); do
  [[ -z "$BACKSTAGE_URL" ]] && BACKSTAGE_URL=$(kubectl get svc backstage -n backstage \
    -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || echo "")
  [[ -z "$ARGOCD_URL" ]] && ARGOCD_URL=$(kubectl get ingress argocd-server -n argocd \
    -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || echo "")
  [[ -z "$GRAFANA_URL" ]] && GRAFANA_URL=$(kubectl get ingress prometheus-grafana -n monitoring \
    -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || echo "")
  [[ -n "$BACKSTAGE_URL" && -n "$ARGOCD_URL" && -n "$GRAFANA_URL" ]] && break
  sleep 10
done
if [[ -z "$BACKSTAGE_URL" ]]; then
  log "  Backstage LoadBalancer hostname not ready — skipping URL patch."
  BACKSTAGE_URL="PENDING"
fi
[[ -z "$ARGOCD_URL" ]] && log "  ArgoCD ALB hostname not ready — leaving externalLinks.argocd as a placeholder."
[[ -z "$GRAFANA_URL" ]] && log "  Grafana ALB hostname not ready — leaving externalLinks.grafana as a placeholder."

# Patch the configmap with the real ALB URLs and restart the pod
if [[ "$BACKSTAGE_URL" != "PENDING" ]]; then
  kubectl get configmap backstage-config -n backstage -o json \
    | sed "s|BACKSTAGE_ALB_URL|${BACKSTAGE_URL}|g" \
    | sed "s|ARGOCD_ALB_URL|${ARGOCD_URL:-ARGOCD_ALB_URL}|g" \
    | sed "s|GRAFANA_ALB_URL|${GRAFANA_URL:-GRAFANA_ALB_URL}|g" \
    | kubectl apply -f -
  kubectl rollout restart deployment/backstage -n backstage
fi

kubectl rollout status deployment/backstage -n backstage --timeout=120s || \
  log "  WARNING: Backstage rollout did not complete in time — check pod logs."

timer_end "5.6 Deploy Backstage"

# ── Phase 5.7: Catalog exporter CronJob ──────────────────────────────────────
timer_start "5.7 Catalog exporter"
if [[ "$SKIP_DORA" != "true" ]]; then
  log "Phase 5.7: Deploying catalog exporter CronJob..."
  cd "$ROOT_DIR"
  bash scripts/apply-catalog-exporter.sh
  log "  Catalog exporter deployed."
fi

timer_end "5.7 Catalog exporter"

# ── Phase 5.8: AlertManager routing (Slack + PagerDuty) ─────────────────────
timer_start "5.8 AlertManager"
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

timer_end "5.8 AlertManager"

# ── Phase 6a: Argo Workflows (optional, for ML pipeline orchestration) ──────────
# Backgrounded: this phase shares nothing with Phase 6 (the AI/ML install),
# which is by far the longest phase here. Launched before it and joined after.
_P6A_PID=""
_P6A_LOG=$(mktemp)
(
  set -e
  if [[ "$SKIP_AI" != "true" ]]; then
    log "Phase 6a: Installing Argo Workflows for ML orchestration..."
    (
      set -e

      # Create S3 bucket for Argo artifacts if needed
      ARGO_BUCKET="argo-workflows-artifacts-${CLUSTER_NAME}"
      if ! aws s3 ls "s3://${ARGO_BUCKET}/" --region "${AWS_REGION}" &>/dev/null; then
        log "Creating S3 bucket for Argo Workflows artifacts..."
        aws s3 mb "s3://${ARGO_BUCKET}" --region "${AWS_REGION}" 2>/dev/null || true
      fi

      # Get the Argo Workflows IRSA role ARN from Terraform (if it exists)
      ARGO_ROLE_ARN=$(tf_output argo_workflows_role_arn)

      # Install Argo Workflows with AWS values
      VALUES_FILE="${ROOT_DIR}/aws/argo-workflows/values.yaml"
      sed "s|CLUSTER_NAME_PLACEHOLDER|${CLUSTER_NAME}|g; s|REGION_PLACEHOLDER|${AWS_REGION}|g; s|ARGO_WORKFLOWS_ROLE_ARN_PLACEHOLDER|${ARGO_ROLE_ARN}|g; s|BACKSTAGE_ALB_URL_PLACEHOLDER|${BACKSTAGE_URL}|g" \
        "$VALUES_FILE" > /tmp/argo-values-${CLUSTER_NAME}.yaml

      helm_upgrade_cached argo-workflows argo-workflows argo/argo-workflows \
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


) >"$_P6A_LOG" 2>&1 &
_P6A_PID=$!

# ── Phase 6b: Velero cluster backup ───────────────────────────────────────────
# Backgrounded: this phase shares nothing with Phase 6 (the AI/ML install),
# which is by far the longest phase here. Launched before it and joined after.
_P6B_PID=""
_P6B_LOG=$(mktemp)
(
  set -e
  # Protects PVCs (Grafana/Prometheus/MLflow data), ArgoCD state, and cluster config
  # via daily backups to the S3 bucket + IRSA role provisioned in terraform/s3.tf
  # and terraform/iam.tf. To test a restore: `velero backup get` to find a backup
  # name, then `velero restore create --from-backup <name>`.
  if [[ "$SKIP_VELERO" != "true" ]]; then
    log "Phase 6b: Installing Velero for cluster backup..."
    VELERO_BUCKET=$(tf_output velero_backups_bucket_name)
    VELERO_ROLE_ARN=$(tf_output velero_role_arn)

    if [[ -z "$VELERO_BUCKET" || -z "$VELERO_ROLE_ARN" ]]; then
      log "  WARNING: Velero terraform outputs missing — skipping Velero install."
    else

      kubectl create namespace velero --dry-run=client -o yaml | kubectl apply -f -
      kubectl create serviceaccount velero -n velero --dry-run=client -o yaml | kubectl apply -f -
      kubectl annotate serviceaccount velero -n velero \
        "eks.amazonaws.com/role-arn=${VELERO_ROLE_ARN}" --overwrite

      tmp_velero_values=$(mktemp /tmp/velero-values.XXXXXX)
      cat > "${tmp_velero_values}" <<EOF
serviceAccount:
  server:
    create: false
    name: velero
initContainers:
  - name: velero-plugin-for-aws
    image: velero/velero-plugin-for-aws:v1.10.0
    volumeMounts:
      - mountPath: /target
        name: plugins
configuration:
  backupStorageLocation:
    - name: default
      provider: aws
      bucket: ${VELERO_BUCKET}
      config:
        region: ${AWS_REGION}
  volumeSnapshotLocation:
    - name: default
      provider: aws
      config:
        region: ${AWS_REGION}
snapshotsEnabled: true
deployNodeAgent: true
EOF

      helm_upgrade_cached velero velero vmware-tanzu/velero \
        --namespace velero \
        --values "${tmp_velero_values}" \
        --wait --timeout 5m
      rm -f "${tmp_velero_values}"

      # Daily backup schedule — 30-day TTL matches var.rds_backup_retention_days.
      kubectl apply -f - <<'EOF'
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: daily-cluster-backup
  namespace: velero
spec:
  schedule: "0 3 * * *"
  template:
    ttl: 720h0m0s
    includedNamespaces:
      - backstage
      - argocd
      - monitoring
      - ml-platform
      - kagent
    snapshotVolumes: true
EOF

      log "Velero installed — daily backups scheduled at 03:00 UTC (30-day retention)."
    fi
  else
    log "Phase 6b: Skipping Velero (--skip-velero flag)"
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
  log "║    AI Assistant    http://${BACKSTAGE_URL:-PENDING}/ai-assistant"
  log "╠══════════════════════════════════════════════════════════════════════════════╣"
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

) >"$_P6B_LOG" 2>&1 &
_P6B_PID=$!

# ── Phase 6: AI/ML platform (KAgent + MLflow + MCP servers) ──────────────────
timer_start "6. AI/ML platform"
if [[ "$SKIP_AI" != "true" ]]; then
  log "Phase 6: Deploying AI/ML platform..."
  cd "$ROOT_DIR"
  bash scripts/bootstrap-ai.sh --aws --region "${AWS_REGION}" --cluster "${CLUSTER_NAME}"
fi

timer_end "6. AI/ML platform"

# ── Phase 6a/6b join ─────────────────────────────────────────────────────────
timer_start "6a/6b. Argo Workflows + Velero (parallel with 6)"
_bg_join "$_P6A_PID" "$_P6A_LOG" || log "  WARNING: Phase 6a (Argo Workflows) failed — non-critical for platform operation."
_bg_join "$_P6B_PID" "$_P6B_LOG" || log "  WARNING: Phase 6b (Velero) failed — cluster backups are not configured."
_P6A_PID=""; _P6B_PID=""
timer_end "6a/6b. Argo Workflows + Velero (parallel with 6)"
