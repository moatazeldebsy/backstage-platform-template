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
die()   { echo "✗ ERROR: $*" >&2; exit 1; }

# ── Pre-flight ────────────────────────────────────────────────────────────────

command -v kubectl >/dev/null || die "kubectl not found"
command -v helm    >/dev/null || die "helm not found"
command -v docker  >/dev/null || die "docker not found"

# ── Destroy mode ──────────────────────────────────────────────────────────────

if $DESTROY; then
  info "Tearing down AI/ML platform components (core platform untouched)..."
  helm uninstall kagent      --namespace kagent   2>/dev/null || true
  helm uninstall kagent-crds --namespace kagent   2>/dev/null || true
  kubectl delete -f "${REPO_ROOT}/kubernetes/kagent/idp-agent.yaml"   2>/dev/null || true
  kubectl delete -f "${REPO_ROOT}/kubernetes/kagent/qa-agent.yaml"    2>/dev/null || true
  kubectl delete -f "${REPO_ROOT}/kubernetes/kagent/toolserver.yaml"  2>/dev/null || true
  kubectl delete -f "${REPO_ROOT}/kubernetes/kagent/qa-toolserver.yaml" 2>/dev/null || true
  kubectl delete -f "${REPO_ROOT}/kubernetes/kagent/modelconfig.yaml" 2>/dev/null || true
  kubectl delete secret kagent-anthropic -n kagent 2>/dev/null || true
  kubectl delete -f "${REPO_ROOT}/kubernetes/ml-platform/mlflow.yaml"     2>/dev/null || true
  kubectl delete -f "${REPO_ROOT}/kubernetes/ml-platform/mlflow-aws.yaml" 2>/dev/null || true
  helm uninstall idp-mcp-server --namespace services 2>/dev/null || true
  helm uninstall qa-mcp-server  --namespace services 2>/dev/null || true
  kubectl delete namespace kagent ml-platform 2>/dev/null || true
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
  kind get clusters 2>/dev/null | grep -q "." || die "No Kind cluster found. Run ./scripts/bootstrap-local.sh first."
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
    --values "${KAGENT_VALUES}" \
    --wait \
    --timeout 5m

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

  info "Applying KAgent ModelConfig, Ingress, and IDP Assistant agent..."
  kubectl apply -f "${REPO_ROOT}/kubernetes/kagent/modelconfig.yaml"
  kubectl apply -f "${REPO_ROOT}/kubernetes/kagent/toolserver.yaml"
  kubectl apply -f "${REPO_ROOT}/kubernetes/kagent/idp-agent.yaml"

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
    check "IDP Assistant agent defined (claude-haiku-4-5-20251001)"
    check "KAgent ExternalSecret → idp-mvp/kagent (Secrets Manager)"
    check "KAgent UI ingress → ALB (AWS Load Balancer Controller)"
  else
    # Local: create API key secret directly + nginx ingress with TLS
    kubectl apply -f "${REPO_ROOT}/kubernetes/kagent/ingress.yaml"
    check "IDP Assistant agent defined (claude-haiku-4-5-20251001)"
    check "KAgent UI ingress → https://kagent.idp.local"

    # ── 5b. TLS for kagent.idp.local (mkcert) ─────────────────────────────────
    # crypto.randomUUID() requires a secure context (HTTPS). We use mkcert to
    # generate a locally-trusted cert so Chrome accepts it without warnings.
    if command -v mkcert &>/dev/null; then
      info "Generating mkcert TLS cert for kagent.idp.local..."
      mkcert -install 2>/dev/null || true
      TLS_DIR="$(mktemp -d)"
      mkcert -cert-file "${TLS_DIR}/tls.crt" -key-file "${TLS_DIR}/tls.key" kagent.idp.local
      kubectl create secret tls kagent-tls \
        --cert="${TLS_DIR}/tls.crt" \
        --key="${TLS_DIR}/tls.key" \
        -n kagent \
        --dry-run=client -o yaml | kubectl apply -f -
      rm -rf "${TLS_DIR}"
      check "TLS secret kagent-tls created (valid for kagent.idp.local)"
    else
      info "mkcert not found — skipping TLS. Install with: brew install mkcert"
      info "Then run: mkcert -install && mkcert kagent.idp.local"
      info "And:      kubectl create secret tls kagent-tls --cert=kagent.idp.local.pem --key=kagent.idp.local-key.pem -n kagent"
    fi

    # ── 5c. SSR resolution ────────────────────────────────────────────────────
    # Next.js SSR API calls are routed via ui.backendInternalUrl in
    # local/kagent/values.yaml → kagent-controller.kagent.svc.cluster.local:8083
    # No hostAliases patch needed; the controller is reached directly in-cluster.
    check "kagent-ui SSR → kagent-controller.kagent.svc.cluster.local:8083"
  fi
fi

# ── 6. IDP MCP Server ─────────────────────────────────────────────────────────

if [[ "$SKIP_MCP" == "true" ]]; then
  info "Skipping IDP/QA MCP Servers (--skip-mcp)."
else
  # ── IDP MCP Server ───────────────────────────────────────────────────────────
  info "Building IDP MCP Server..."
  if [[ "$DEPLOY_MODE" == "aws" ]]; then
    docker build \
      --platform linux/amd64 --provenance=false \
      -t "${REGISTRY}/idp-mcp-server:0.1.0" \
      -t "${REGISTRY}/idp-mcp-server:latest" \
      "${REPO_ROOT}/services/idp-mcp-server/"
    docker push "${REGISTRY}/idp-mcp-server:0.1.0"
    docker push "${REGISTRY}/idp-mcp-server:latest"
    sed "s|ECR_REGISTRY_PLACEHOLDER|${REGISTRY}|g" \
      "${REPO_ROOT}/services/idp-mcp-server/helm-values-aws.yaml" \
      | helm upgrade --install idp-mcp-server "${REPO_ROOT}/helm/service-template" \
          --namespace services --values /dev/stdin --wait --timeout 3m
  else
    docker build -t "${REGISTRY}/idp-mcp-server:0.1.0" -t "${REGISTRY}/idp-mcp-server:latest" "${REPO_ROOT}/services/idp-mcp-server/"
    docker push "${REGISTRY}/idp-mcp-server:0.1.0"
    docker push "${REGISTRY}/idp-mcp-server:latest"
    helm upgrade --install idp-mcp-server "${REPO_ROOT}/helm/service-template" \
      --namespace services \
      --values "${REPO_ROOT}/services/idp-mcp-server/helm-values-local.yaml" \
      --wait --timeout 3m
  fi

  # Force a rollout restart so Kubernetes pulls the freshly pushed image
  # (pullPolicy: Always but tag may not change between runs).
  kubectl rollout restart deployment/idp-mcp-server -n services
  kubectl rollout status  deployment/idp-mcp-server -n services --timeout 90s

  # Apply the KAgent RemoteMCPServer manifest (STREAMABLE_HTTP protocol).
  kubectl apply -f "${REPO_ROOT}/kubernetes/kagent/toolserver.yaml"

  if [[ "$DEPLOY_MODE" == "aws" ]]; then
    check "IDP MCP Server deployed → ALB (AWS Load Balancer Controller)"
  else
    check "IDP MCP Server deployed → http://idp-mcp-server.idp.local"
  fi

  # ── QA MCP Server ─────────────────────────────────────────────────────────────
  info "Building QA MCP Server..."
  if [[ "$DEPLOY_MODE" == "aws" ]]; then
    docker build \
      --platform linux/amd64 --provenance=false \
      -t "${REGISTRY}/qa-mcp-server:0.1.0" \
      -t "${REGISTRY}/qa-mcp-server:latest" \
      "${REPO_ROOT}/services/qa-mcp-server/"
    docker push "${REGISTRY}/qa-mcp-server:0.1.0"
    docker push "${REGISTRY}/qa-mcp-server:latest"
    sed "s|ECR_REGISTRY_PLACEHOLDER|${REGISTRY}|g" \
      "${REPO_ROOT}/services/qa-mcp-server/helm-values-aws.yaml" \
      | helm upgrade --install qa-mcp-server "${REPO_ROOT}/helm/service-template" \
          --namespace services --values /dev/stdin --wait --timeout 3m
  else
    docker build -t "${REGISTRY}/qa-mcp-server:0.1.0" -t "${REGISTRY}/qa-mcp-server:latest" "${REPO_ROOT}/services/qa-mcp-server/"
    docker push "${REGISTRY}/qa-mcp-server:0.1.0"
    docker push "${REGISTRY}/qa-mcp-server:latest"
    helm upgrade --install qa-mcp-server "${REPO_ROOT}/helm/service-template" \
      --namespace services \
      --values "${REPO_ROOT}/services/qa-mcp-server/helm-values-local.yaml" \
      --wait --timeout 3m
  fi

  kubectl rollout restart deployment/qa-mcp-server -n services
  kubectl rollout status  deployment/qa-mcp-server -n services --timeout 90s
  kubectl apply -f "${REPO_ROOT}/kubernetes/kagent/qa-toolserver.yaml"
  kubectl apply -f "${REPO_ROOT}/kubernetes/kagent/qa-agent.yaml"

  if [[ "$DEPLOY_MODE" == "aws" ]]; then
    check "QA MCP Server deployed → ALB (AWS Load Balancer Controller)"
  else
    check "QA MCP Server deployed → http://qa-mcp-server.idp.local"
  fi
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

# ── 8. hosts-append.txt reminder ─────────────────────────────────────────────

if [[ "$DEPLOY_MODE" == "local" ]] && ! grep -q "mlflow.idp.local" /etc/hosts 2>/dev/null; then
  echo ""
  echo "⚠  Add AI platform hosts to /etc/hosts:"
  echo "   sudo sh -c 'grep \"mlflow\|kagent\|idp-mcp-server\" ${REPO_ROOT}/local/hosts-append.txt >> /etc/hosts'"
fi

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║        AI Platform Bootstrap Complete                    ║"
echo "╠══════════════════════════════════════════════════════════╣"
if [[ "$DEPLOY_MODE" == "aws" ]]; then
  [[ "$SKIP_MLFLOW"  == "false" ]] && echo "║  MLflow UI       ALB DNS (kubectl get ingress -n ml-platform)║"
  [[ "$SKIP_MCP"     == "false" ]] && echo "║  IDP MCP Server  ALB DNS (kubectl get ingress -n services)   ║"
  [[ "$SKIP_MCP"     == "false" ]] && echo "║  QA MCP Server   ALB DNS (kubectl get ingress -n services)   ║"
  [[ "$SKIP_KAGENT"  == "false" ]] && echo "║  KAgent UI       ALB DNS (kubectl get ingress -n kagent)     ║"
else
  [[ "$SKIP_MLFLOW"  == "false" ]] && echo "║  MLflow UI       http://mlflow.idp.local                 ║"
  [[ "$SKIP_MCP"     == "false" ]] && echo "║  IDP MCP Server  http://idp-mcp-server.idp.local/healthz ║"
  [[ "$SKIP_MCP"     == "false" ]] && echo "║  QA MCP Server   http://qa-mcp-server.idp.local/healthz  ║"
  [[ "$SKIP_KAGENT"  == "false" ]] && echo "║  KAgent UI       http://kagent.idp.local                 ║"
  [[ "$SKIP_KAGENT"  == "false" ]] && echo "║                  http://localhost:8082 (port-forward)    ║"
fi
echo "║  Model           Claude Haiku (Anthropic API)            ║"
echo "║  Backstage       http://localhost:3000/create             ║"
[[ "$SKIP_KAGENT"  == "false" ]] && echo "║                  → 'AI Agent (KAgent)' template          ║"
[[ "$SKIP_MLFLOW"  == "false" ]] && echo "║                  → 'ML Experiment (MLflow)' template     ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
if [[ "$SKIP_MCP" == "false" && "$DEPLOY_MODE" == "local" ]]; then
  echo "  Register CI runners for MCP servers (optional, for local CD):"
  echo "    ./scripts/setup-runner.sh --repo idp-mcp-server"
  echo "    ./scripts/setup-runner.sh --repo qa-mcp-server"
  echo ""
fi
