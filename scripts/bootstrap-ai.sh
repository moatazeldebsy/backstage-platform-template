#!/usr/bin/env bash
# bootstrap-ai.sh — Install the AI/ML/MCP platform stack.
# Run after bootstrap-local.sh (local Kind) or bootstrap.sh (AWS/EKS).
#
# Usage: ./scripts/bootstrap-ai.sh [OPTIONS]
#
# Options:
#   --aws              Deploy to AWS/EKS instead of local Kind
#   --region <region>  AWS region (default: us-east-1, used with --aws)
#   --cluster <name>   EKS cluster name (default: idp-mvp, used with --aws)
#   --skip-mlflow      Skip MLflow tracking server
#   --skip-kagent      Skip KAgent CRDs and Helm install
#   --skip-mcp         Skip IDP/QA MCP Server build and deploy
#   --destroy          Remove AI/ML components only (keeps core platform running)

set -euo pipefail

DEPLOY_MODE="local"
AWS_REGION="${AWS_REGION:-us-east-1}"
CLUSTER_NAME="${CLUSTER_NAME:-idp-mvp}"
SKIP_MLFLOW=false
SKIP_KAGENT=false
SKIP_MCP=false
DESTROY=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --aws)          DEPLOY_MODE="aws"; shift ;;
    --region)       AWS_REGION="$2"; shift 2 ;;
    --cluster)      CLUSTER_NAME="$2"; shift 2 ;;
    --skip-mlflow)  SKIP_MLFLOW=true; shift ;;
    --skip-kagent)  SKIP_KAGENT=true; shift ;;
    --skip-mcp)     SKIP_MCP=true; shift ;;
    --destroy)      DESTROY=true; shift ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${REPO_ROOT}/local/.env"

info()  { echo "  [ai] $*"; }
check() { echo "✓ $*"; }
warn()  { echo "  [ai] WARNING: $*" >&2; }
log()   { echo "  [ai] $*"; }
die()   { echo "✗ ERROR: $*" >&2; exit 1; }

# ── Pre-flight ────────────────────────────────────────────────────────────────

command -v kubectl >/dev/null || die "kubectl not found"
command -v helm    >/dev/null || die "helm not found"
command -v docker  >/dev/null || die "docker not found"

# ── Destroy mode ──────────────────────────────────────────────────────────────

if $DESTROY; then
  info "Tearing down AI/ML platform components (core platform untouched)..."

  # Ingresses first — deleting the namespace races with finalizer cleanup
  kubectl delete -f "${REPO_ROOT}/kubernetes/kagent/ingress.yaml"              2>/dev/null || true
  kubectl delete -f "${REPO_ROOT}/kubernetes/kagent/ingress-idp-assistant.yaml" 2>/dev/null || true
  kubectl delete -f "${REPO_ROOT}/kubernetes/kagent/ingress-aws.yaml"          2>/dev/null || true

  # KAgent Helm releases + resources
  helm uninstall kagent      --namespace kagent 2>/dev/null || true
  helm uninstall kagent-crds --namespace kagent 2>/dev/null || true
  kubectl delete -f "${REPO_ROOT}/kubernetes/kagent/idp-agent.yaml"    2>/dev/null || true
  kubectl delete -f "${REPO_ROOT}/kubernetes/kagent/qa-agent.yaml"     2>/dev/null || true
  kubectl delete -f "${REPO_ROOT}/kubernetes/kagent/toolserver.yaml"   2>/dev/null || true
  kubectl delete -f "${REPO_ROOT}/kubernetes/kagent/qa-toolserver.yaml" 2>/dev/null || true
  kubectl delete -f "${REPO_ROOT}/kubernetes/kagent/modelconfig.yaml"  2>/dev/null || true
  kubectl delete secret kagent-anthropic -n kagent 2>/dev/null || true

  # MLflow
  kubectl delete -f "${REPO_ROOT}/kubernetes/ml-platform/mlflow.yaml"     2>/dev/null || true
  kubectl delete -f "${REPO_ROOT}/kubernetes/ml-platform/mlflow-aws.yaml" 2>/dev/null || true

  # MCP servers (services-dev namespace)
  helm uninstall idp-mcp-server --namespace services-dev 2>/dev/null || true
  helm uninstall qa-mcp-server  --namespace services-dev 2>/dev/null || true
  # Remove services-dev only if it is now empty
  if [[ -z "$(kubectl get all -n services-dev --ignore-not-found -o name 2>/dev/null)" ]]; then
    kubectl delete namespace services-dev 2>/dev/null || true
  else
    warn "services-dev still has resources — namespace left in place."
  fi

  # Delete namespaces (waits for all pods to terminate)
  kubectl delete namespace kagent ml-platform --wait=true 2>/dev/null || true

  info "Done. Re-run ./scripts/bootstrap-ai.sh to reinstall."
  exit 0
fi

if [[ "$DEPLOY_MODE" == "aws" ]]; then
  command -v aws >/dev/null || die "aws CLI not found"
  aws sts get-caller-identity &>/dev/null || die "AWS credentials not configured"
  ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
  REGISTRY="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${CLUSTER_NAME}"
  # Login to ECR once; subsequent docker push calls reuse the session
  aws ecr get-login-password --region "${AWS_REGION}" | \
    docker login --username AWS --password-stdin \
      "${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
  # Fetch ANTHROPIC_API_KEY from Secrets Manager (if not already in env)
  if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
    ANTHROPIC_API_KEY=$(aws secretsmanager get-secret-value \
      --secret-id "idp-mvp/kagent" \
      --region "${AWS_REGION}" \
      --query 'SecretString' --output text 2>/dev/null \
      | python3 -c "import json,sys; print(json.load(sys.stdin).get('ANTHROPIC_API_KEY',''))" \
      2>/dev/null || echo "")
  fi
else
  REGISTRY="localhost:5003"
  # Read provider from local/.env (set by setup.sh / user)
  _provider="${KUBERNETES_PROVIDER:-kind}"
  if [[ -f "${ENV_FILE}" ]]; then
    _provider="${_provider:-$(grep '^KUBERNETES_PROVIDER=' "${ENV_FILE}" | cut -d= -f2- | tr -d '"' || echo 'kind')}"
  fi
  if [[ "$_provider" == "kind" ]]; then
    kind get clusters 2>/dev/null | grep -q "." || die "No Kind cluster found. Run ./scripts/bootstrap-local.sh first."
  else
    kubectl cluster-info --context rancher-desktop &>/dev/null || \
      die "Rancher Desktop cluster not reachable. Start Rancher Desktop and run ./scripts/bootstrap-local.sh --provider rancher-desktop first."
  fi
  # Load ANTHROPIC_API_KEY from local/.env if not already set
  if [[ -f "${ENV_FILE}" ]]; then
    ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-$(grep '^ANTHROPIC_API_KEY=' "${ENV_FILE}" | cut -d= -f2-)}"
  fi
fi

[[ -n "${ANTHROPIC_API_KEY:-}" ]] || die "ANTHROPIC_API_KEY is not set. Add it to local/.env (local) or to AWS Secrets Manager at idp-mvp/kagent (AWS)."

info "Starting AI platform bootstrap (Claude API, mode=${DEPLOY_MODE})..."
echo ""

# ── 1. Namespaces ─────────────────────────────────────────────────────────────

info "Applying namespaces (ml-platform, kagent)..."
kubectl apply -f "${REPO_ROOT}/kubernetes/namespaces/namespaces.yaml"
check "Namespaces ready"

# ── 2. Anthropic API key secret ───────────────────────────────────────────────

info "Creating kagent-anthropic secret in kagent namespace..."
kubectl create secret generic kagent-anthropic \
  --namespace kagent \
  --from-literal=ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY}" \
  --dry-run=client -o yaml | kubectl apply -f -
check "Secret kagent-anthropic ready"

# ── 3. MLflow ─────────────────────────────────────────────────────────────────

if [[ "$SKIP_MLFLOW" == "true" ]]; then
  info "Skipping MLflow (--skip-mlflow)."
else
  info "Deploying MLflow tracking server..."
  if [[ "$DEPLOY_MODE" == "aws" ]]; then
    MLFLOW_BUCKET=$(cd "${REPO_ROOT}/terraform" && terraform output -raw mlflow_artifacts_bucket_name 2>/dev/null || echo "")
    [[ -n "$MLFLOW_BUCKET" ]] || die "Could not read mlflow_artifacts_bucket_name from Terraform outputs. Run terraform apply first."
    MLFLOW_ROLE_ARN=$(cd "${REPO_ROOT}/terraform" && terraform output -raw mlflow_role_arn 2>/dev/null || echo "")
    [[ -n "$MLFLOW_ROLE_ARN" ]] || die "Could not read mlflow_role_arn from Terraform outputs."
    sed "s|MLFLOW_ARTIFACTS_BUCKET_PLACEHOLDER|${MLFLOW_BUCKET}|g" \
      "${REPO_ROOT}/kubernetes/ml-platform/mlflow-aws.yaml" | kubectl apply -f -
    kubectl annotate serviceaccount mlflow \
      -n ml-platform \
      "eks.amazonaws.com/role-arn=${MLFLOW_ROLE_ARN}" \
      --overwrite
    kubectl rollout status deployment/mlflow -n ml-platform --timeout=180s
    check "MLflow deployed (S3 artifacts → s3://${MLFLOW_BUCKET}/artifacts)"
  else
    kubectl apply -f "${REPO_ROOT}/kubernetes/ml-platform/mlflow.yaml"
    kubectl rollout status deployment/mlflow -n ml-platform --timeout=180s
    check "MLflow deployed → http://mlflow.idp.local"
  fi
fi

# ── 4. KAgent ─────────────────────────────────────────────────────────────────

if [[ "$SKIP_KAGENT" == "true" ]]; then
  info "Skipping KAgent (--skip-kagent)."
else
  info "Installing KAgent via Helm (OCI registry)..."
  helm upgrade --install kagent-crds \
    oci://ghcr.io/kagent-dev/kagent/helm/kagent-crds \
    --namespace kagent \
    --create-namespace \
    --wait \
    --timeout 5m

  KAGENT_VALUES="${REPO_ROOT}/local/kagent/values.yaml"
  [[ "$DEPLOY_MODE" == "aws" ]] && KAGENT_VALUES="${REPO_ROOT}/kubernetes/kagent/values-aws.yaml"

  helm upgrade --install kagent \
    oci://ghcr.io/kagent-dev/kagent/helm/kagent \
    --namespace kagent \
    --values "${KAGENT_VALUES}"
  # Don't --wait here: built-in Agent CRDs (argo-rollouts, cilium, etc.) take
  # longer than helm's wait window to reach Ready. Poll the controller pod only.
  kubectl rollout status deployment/kagent-controller -n kagent --timeout=5m || \
    warn "kagent-controller not ready yet — pods are starting, will self-heal. Continuing..."

  check "KAgent installed"

  # ── 4b. Patch PostgreSQL to use pgvector image ───────────────────────────────
  # The KAgent helm chart (v0.9.2) does not propagate postgres.bundled.image or
  # postgres.vectorEnabled into the rendered Deployment/ConfigMap.  We patch
  # them directly so the `memory` table (vector(768) column) can be created.
  info "Patching kagent-postgresql to pgvector image and enabling DATABASE_VECTOR_ENABLED..."

  # Switch the bundled postgres to the pgvector-enabled image.
  kubectl patch deployment kagent-postgresql -n kagent \
    --type='json' \
    --patch='[{"op":"replace","path":"/spec/template/spec/containers/0/image","value":"pgvector/pgvector:pg18"},{"op":"replace","path":"/spec/template/spec/containers/0/imagePullPolicy","value":"IfNotPresent"}]'
  kubectl rollout status deployment/kagent-postgresql -n kagent --timeout=120s

  # Enable vector support in the controller ConfigMap.
  kubectl patch configmap kagent-controller -n kagent \
    --patch='{"data":{"DATABASE_VECTOR_ENABLED":"true"}}'

  # Wait for postgres to be accepting connections, then create the extension.
  PG_POD=$(kubectl get pod -n kagent --no-headers | awk '/postgresql/{print $1;exit}')
  for i in $(seq 1 20); do
    if kubectl exec -n kagent "$PG_POD" -- psql -U kagent -d kagent -c "SELECT 1" &>/dev/null 2>&1; then
      break
    fi
    sleep 3
  done
  kubectl exec -n kagent "$PG_POD" -- \
    psql -U kagent -d kagent -c "CREATE EXTENSION IF NOT EXISTS vector;" 2>&1 || true

  # Restart the controller so it picks up DATABASE_VECTOR_ENABLED=true and
  # runs the AutoMigrate that creates the memory table.
  kubectl rollout restart deployment/kagent-controller -n kagent
  kubectl rollout status  deployment/kagent-controller -n kagent --timeout=120s
  check "pgvector extension enabled → memory table will be created on controller start"

  # ── 5. KAgent resources ─────────────────────────────────────────────────────

  info "Applying KAgent ModelConfig, Ingress, agents, and MCP server registrations..."
  kubectl apply -f "${REPO_ROOT}/kubernetes/kagent/modelconfig.yaml"
  kubectl apply -f "${REPO_ROOT}/kubernetes/kagent/toolserver.yaml"
  kubectl apply -f "${REPO_ROOT}/kubernetes/kagent/idp-agent.yaml"
  kubectl apply -f "${REPO_ROOT}/kubernetes/kagent/qa-toolserver.yaml"
  kubectl apply -f "${REPO_ROOT}/kubernetes/kagent/qa-agent.yaml"

  if [[ "$DEPLOY_MODE" == "aws" ]]; then
    # AWS: sync Anthropic API key via ExternalSecret + use ALB ingress
    KAGENT_ESO_ROLE_ARN=$(cd "${REPO_ROOT}/terraform" && terraform output -raw kagent_eso_role_arn 2>/dev/null || echo "")
    [[ -n "$KAGENT_ESO_ROLE_ARN" ]] || die "Could not read kagent_eso_role_arn from Terraform outputs."
    sed "s|AWS_REGION_PLACEHOLDER|${AWS_REGION}|g" \
      "${REPO_ROOT}/kubernetes/kagent/external-secret-aws.yaml" | kubectl apply -f -
    kubectl annotate serviceaccount kagent-eso-sa \
      -n kagent \
      "eks.amazonaws.com/role-arn=${KAGENT_ESO_ROLE_ARN}" \
      --overwrite
    kubectl apply -f "${REPO_ROOT}/kubernetes/kagent/ingress-aws.yaml"
    check "IDP + QA agents defined (claude-haiku-4-5-20251001)"
    check "KAgent ExternalSecret → idp-mvp/kagent (Secrets Manager)"
    check "KAgent UI ingress → ALB (AWS Load Balancer Controller)"
  else
    # Local: create API key secret directly + nginx ingresses (HTTP)
    kubectl apply -f "${REPO_ROOT}/kubernetes/kagent/ingress.yaml"
    kubectl apply -f "${REPO_ROOT}/kubernetes/kagent/ingress-idp-assistant.yaml"
    check "IDP + QA agents defined (claude-haiku-4-5-20251001)"
    check "KAgent UI ingress → http://kagent.idp.local"
    check "IDP Assistant ingress → http://idp-assistant.idp.local"

    # ── 5c. SSR resolution ────────────────────────────────────────────────────
    # Next.js SSR API calls are routed via ui.backendInternalUrl in
    # local/kagent/values.yaml → kagent-controller.kagent.svc.cluster.local:8083
    # No hostAliases patch needed; the controller is reached directly in-cluster.
    check "kagent-ui SSR → kagent-controller.kagent.svc.cluster.local:8083"
  fi
fi

# ── 6. IDP / QA MCP Servers ───────────────────────────────────────────────────
# Local: build images into the local registry; ArgoCD (services-dev namespace)
#        manages the actual Kubernetes deployment via GitOps.
# AWS:   build, push to ECR, and Helm-deploy directly (ArgoCD handles day-2).

if [[ "$SKIP_MCP" == "true" ]]; then
  info "Skipping IDP/QA MCP Servers (--skip-mcp)."
else
  # AWS: create mcp-backstage-token secret in services-dev so MCP servers can
  # authenticate against the Backstage catalog API. The token value comes from
  # Secrets Manager (idp-mvp/backstage → BACKSTAGE_CATALOG_TOKEN) and must match
  # the externalAccess token configured in kubernetes/backstage/configmap.yaml.
  if [[ "$DEPLOY_MODE" == "aws" ]]; then
    info "Creating mcp-backstage-token secret in services-dev..."
    MCP_BS_TOKEN=$(aws secretsmanager get-secret-value \
      --secret-id "${CLUSTER_NAME}/backstage" \
      --query SecretString --output text 2>/dev/null \
      | python3 -c "import json,sys; s=json.load(sys.stdin); print(s.get('BACKSTAGE_CATALOG_TOKEN','REPLACE_ME'))" \
      2>/dev/null || echo "REPLACE_ME")
    if [[ "$MCP_BS_TOKEN" == "REPLACE_ME" ]]; then
      warn "BACKSTAGE_CATALOG_TOKEN not set in Secrets Manager — MCP servers won't authenticate to Backstage."
      warn "Update the secret: aws secretsmanager update-secret --secret-id ${CLUSTER_NAME}/backstage ..."
    fi
    kubectl create secret generic mcp-backstage-token \
      --from-literal=token="${MCP_BS_TOKEN}" \
      --namespace services-dev --dry-run=client -o yaml | kubectl apply -f -
    check "mcp-backstage-token secret created in services-dev"
  fi

  for SVC in idp-mcp-server qa-mcp-server; do
    info "Building ${SVC}..."
    (
      set -e
      if [[ "$DEPLOY_MODE" == "aws" ]]; then
        docker build \
          --platform linux/amd64 --provenance=false \
          -t "${REGISTRY}/${SVC}:0.1.0" \
          -t "${REGISTRY}/${SVC}:latest" \
          "${REPO_ROOT}/services/${SVC}/"
        docker push "${REGISTRY}/${SVC}:0.1.0"
        docker push "${REGISTRY}/${SVC}:latest"
        sed "s|ECR_REGISTRY_PLACEHOLDER|${REGISTRY}|g" \
          "${REPO_ROOT}/services/${SVC}/helm-values-dev.yaml" \
          | helm upgrade --install "${SVC}" "${REPO_ROOT}/helm/service-template" \
              --namespace services-dev --create-namespace --values /dev/stdin --wait --timeout 3m
        check "${SVC} deployed → ALB"
      else
        docker build \
          -t "${REGISTRY}/${SVC}:0.1.0" \
          -t "${REGISTRY}/${SVC}:latest" \
          "${REPO_ROOT}/services/${SVC}/"
        docker push "${REGISTRY}/${SVC}:0.1.0"
        docker push "${REGISTRY}/${SVC}:latest"
        # Try ArgoCD sync first; fall back to direct Helm install when the
        # ArgoCD application hasn't been registered yet (first-time install
        # before app-of-apps-local.yaml is applied).
        if argocd app get "${SVC}-local" --grpc-web &>/dev/null; then
          argocd app sync "${SVC}-local" --grpc-web 2>/dev/null || true
        else
          info "${SVC}-local ArgoCD app not found — deploying directly with Helm..."
          helm upgrade --install "${SVC}" "${REPO_ROOT}/helm/service-template" \
            --namespace services-dev --create-namespace \
            --values "${REPO_ROOT}/services/${SVC}/helm-values-local.yaml" \
            --wait --timeout 3m
        fi
        kubectl rollout status deployment/"${SVC}" -n services-dev --timeout 90s
        check "${SVC} deployed to services-dev"
      fi
    ) || warn "${SVC} build/deploy failed — check: kubectl get po -n services-dev"
  done
fi

# ── 7. KAgent UI port-forward (background) ───────────────────────────────────
# Provides direct access at http://localhost:8082 alongside the ingress hostname.
# Kills any stale port-forward first, then starts a fresh background one.

if [[ "$SKIP_KAGENT" == "false" && "$DEPLOY_MODE" == "local" ]]; then
  pkill -f "port-forward.*kagent-ui" 2>/dev/null || true
  sleep 1
  kubectl port-forward -n kagent svc/kagent-ui 8082:8080 \
    --address 127.0.0.1 >/dev/null 2>&1 &
  echo $! > /tmp/kagent-ui-pf.pid
  check "KAgent UI port-forward → http://localhost:8082 (PID $(cat /tmp/kagent-ui-pf.pid))"
fi

# ── 8. /etc/hosts — AI platform entries ──────────────────────────────────────

if [[ "$DEPLOY_MODE" == "local" ]]; then
  HOSTS_ADDED=false
  while IFS= read -r line; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    # Only process AI/ML entries from hosts-append.txt
    echo "$line" | grep -qE "mlflow|kagent|idp-mcp-server|qa-mcp-server" || continue
    hostname=$(awk '{print $2}' <<< "$line")
    [[ -z "$hostname" ]] && continue
    if ! grep -qF "$hostname" /etc/hosts 2>/dev/null; then
      if sudo sh -c "echo '$line' >> /etc/hosts"; then
        log "  Added to /etc/hosts: $hostname"
        HOSTS_ADDED=true
      else
        warn "  Could not add '$hostname' to /etc/hosts. Add manually:"
        warn "  echo '$line' | sudo tee -a /etc/hosts"
      fi
    fi
  done < "${REPO_ROOT}/local/hosts-append.txt"

  if $HOSTS_ADDED && [[ "$(uname)" == "Darwin" ]]; then
    sudo dscacheutil -flushcache 2>/dev/null || true
    sudo killall -HUP mDNSResponder 2>/dev/null || true
    log "  macOS DNS cache flushed."
  fi
fi

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
echo "╔═══════════════════════════════════════════════════════════════════════════╗"
echo "║               AI/ML Platform Bootstrap Complete                          ║"
echo "╠═══════════════════════════════════════════════════════════════════════════╣"
if [[ "$DEPLOY_MODE" == "aws" ]]; then
  [[ "$SKIP_KAGENT"  == "false" ]] && echo "║  KAgent UI        ALB DNS  (kubectl get ingress -n kagent)            ║"
  [[ "$SKIP_MLFLOW"  == "false" ]] && echo "║  MLflow           ALB DNS  (kubectl get ingress -n ml-platform)       ║"
  [[ "$SKIP_MCP"     == "false" ]] && echo "║  IDP MCP Server   ALB DNS  (kubectl get ingress -n services)          ║"
  [[ "$SKIP_MCP"     == "false" ]] && echo "║  QA MCP Server    ALB DNS  (kubectl get ingress -n services)          ║"
else
  [[ "$SKIP_KAGENT"  == "false" ]] && echo "║  KAgent UI        http://kagent.idp.local                            ║"
  [[ "$SKIP_KAGENT"  == "false" ]] && echo "║  AI Assistant     http://backstage.idp.local/ai-assistant            ║"
  [[ "$SKIP_MLFLOW"  == "false" ]] && echo "║  MLflow           http://mlflow.idp.local                            ║"
  [[ "$SKIP_MCP"     == "false" ]] && echo "║  IDP MCP Server   http://idp-mcp-server.idp.local/healthz            ║"
  [[ "$SKIP_MCP"     == "false" ]] && echo "║  QA MCP Server    http://qa-mcp-server.idp.local/healthz             ║"
fi
echo "╠═══════════════════════════════════════════════════════════════════════════╣"
echo "║  Model            Claude Haiku (claude-haiku-4-5-20251001)               ║"
echo "║  All platform URLs: ./scripts/bootstrap-local.sh --print-urls            ║"
echo "╚═══════════════════════════════════════════════════════════════════════════╝"
echo ""
if [[ "$SKIP_MCP" == "false" && "$DEPLOY_MODE" == "local" ]]; then
  echo "  Register CI runners for MCP servers (optional):"
  echo "    ./scripts/setup-runner.sh --repo idp-mcp-server"
  echo "    ./scripts/setup-runner.sh --repo qa-mcp-server"
  echo ""
fi
