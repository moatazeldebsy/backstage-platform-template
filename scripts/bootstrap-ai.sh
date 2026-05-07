#!/usr/bin/env bash
# bootstrap-ai.sh — Install the AI/ML/MCP platform stack into the local Kind cluster.
# Run this after bootstrap-local.sh has the base cluster up.
#
# Usage: ./scripts/bootstrap-ai.sh [OPTIONS]
#
# Options:
#   --skip-mlflow    Skip MLflow tracking server
#   --skip-kagent    Skip KAgent CRDs and Helm install
#   --skip-mcp       Skip IDP MCP Server build and deploy

set -euo pipefail

SKIP_MLFLOW=false
SKIP_KAGENT=false
SKIP_MCP=false

for arg in "$@"; do
  case "$arg" in
    --skip-mlflow)  SKIP_MLFLOW=true ;;
    --skip-kagent)  SKIP_KAGENT=true ;;
    --skip-mcp)     SKIP_MCP=true ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REGISTRY="localhost:5003"
ENV_FILE="${REPO_ROOT}/local/.env"

info()  { echo "  [ai] $*"; }
check() { echo "✓ $*"; }
die()   { echo "✗ ERROR: $*" >&2; exit 1; }

# ── Pre-flight ────────────────────────────────────────────────────────────────

command -v kubectl >/dev/null || die "kubectl not found"
command -v helm    >/dev/null || die "helm not found"
command -v docker  >/dev/null || die "docker not found"

kind get clusters 2>/dev/null | grep -q "." || die "No Kind cluster found. Run ./scripts/bootstrap-local.sh first."

# Load ANTHROPIC_API_KEY from local/.env if not already set
if [[ -f "${ENV_FILE}" ]]; then
  ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-$(grep '^ANTHROPIC_API_KEY=' "${ENV_FILE}" | cut -d= -f2-)}"
fi
[[ -n "${ANTHROPIC_API_KEY:-}" ]] || die "ANTHROPIC_API_KEY is not set. Add it to local/.env (see local/.env.example)."

info "Starting AI platform bootstrap (Claude API)..."
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
  kubectl apply -f "${REPO_ROOT}/kubernetes/ml-platform/mlflow.yaml"
  kubectl rollout status deployment/mlflow -n ml-platform --timeout=180s
  check "MLflow deployed → http://mlflow.idp.local"
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

  helm upgrade --install kagent \
    oci://ghcr.io/kagent-dev/kagent/helm/kagent \
    --namespace kagent \
    --values "${REPO_ROOT}/local/kagent/values.yaml" \
    --wait \
    --timeout 5m

  check "KAgent installed"

  # ── 5. KAgent resources ─────────────────────────────────────────────────────

  info "Applying KAgent ModelConfig, Ingress, and IDP Assistant agent..."
  kubectl apply -f "${REPO_ROOT}/kubernetes/kagent/modelconfig.yaml"
  kubectl apply -f "${REPO_ROOT}/kubernetes/kagent/toolserver.yaml"
  kubectl apply -f "${REPO_ROOT}/kubernetes/kagent/idp-agent.yaml"
  kubectl apply -f "${REPO_ROOT}/kubernetes/kagent/ingress.yaml"
  check "IDP Assistant agent defined (claude-haiku-4-5-20251001)"
  check "KAgent UI ingress → http://kagent.idp.local"

  # ── 5b. Patch kagent-ui with hostAliases ────────────────────────────────────
  # The kagent helm chart does not expose hostAliases in its values, so we
  # patch the Deployment directly after install. This lets the Next.js SSR
  # resolve kagent.idp.local (which only exists in /etc/hosts on the Mac host).
  info "Patching kagent-ui with hostAliases for in-cluster SSR resolution..."
  INGRESS_IP=$(kubectl get svc ingress-nginx-controller -n ingress-nginx \
    -o jsonpath='{.spec.clusterIP}' 2>/dev/null || echo "")
  if [[ -n "${INGRESS_IP}" ]]; then
    kubectl patch deployment kagent-ui -n kagent --type=strategic -p \
      "{\"spec\":{\"template\":{\"spec\":{\"hostAliases\":[{\"ip\":\"${INGRESS_IP}\",\"hostnames\":[\"kagent.idp.local\"]}]}}}}" \
      2>/dev/null || true
    check "kagent-ui hostAliases → kagent.idp.local = ${INGRESS_IP}"
  else
    info "Warning: could not find ingress-nginx ClusterIP — skipping hostAliases patch"
  fi
fi

# ── 6. IDP MCP Server ─────────────────────────────────────────────────────────

if [[ "$SKIP_MCP" == "true" ]]; then
  info "Skipping IDP MCP Server (--skip-mcp)."
else
  info "Building IDP MCP Server..."
  docker build -t "${REGISTRY}/idp-mcp-server:latest" "${REPO_ROOT}/services/idp-mcp-server/"
  docker push "${REGISTRY}/idp-mcp-server:latest"

  info "Deploying IDP MCP Server to Kind..."
  helm upgrade --install idp-mcp-server "${REPO_ROOT}/helm/service-template" \
    --namespace services \
    --values "${REPO_ROOT}/services/idp-mcp-server/helm-values-local.yaml" \
    --wait \
    --timeout 3m

  check "IDP MCP Server deployed → http://idp-mcp-server.idp.local"
fi

# ── 7. KAgent UI port-forward (background) ───────────────────────────────────
# Provides direct access at http://localhost:8082 alongside the ingress hostname.
# Kills any stale port-forward first, then starts a fresh background one.

if [[ "$SKIP_KAGENT" == "false" ]]; then
  pkill -f "port-forward.*kagent-ui" 2>/dev/null || true
  sleep 1
  kubectl port-forward -n kagent svc/kagent-ui 8082:8080 \
    --address 127.0.0.1 >/dev/null 2>&1 &
  echo $! > /tmp/kagent-ui-pf.pid
  check "KAgent UI port-forward → http://localhost:8082 (PID $(cat /tmp/kagent-ui-pf.pid))"
fi

# ── 8. hosts-append.txt reminder ─────────────────────────────────────────────

if ! grep -q "mlflow.idp.local" /etc/hosts 2>/dev/null; then
  echo ""
  echo "⚠  Add AI platform hosts to /etc/hosts:"
  echo "   sudo sh -c 'grep \"mlflow\|kagent\|idp-mcp-server\" ${REPO_ROOT}/local/hosts-append.txt >> /etc/hosts'"
fi

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║        AI Platform Bootstrap Complete                    ║"
echo "╠══════════════════════════════════════════════════════════╣"
[[ "$SKIP_MLFLOW"  == "false" ]] && echo "║  MLflow UI       http://mlflow.idp.local                 ║"
[[ "$SKIP_MCP"     == "false" ]] && echo "║  MCP Server      http://idp-mcp-server.idp.local/healthz ║"
[[ "$SKIP_KAGENT"  == "false" ]] && echo "║  KAgent UI       http://kagent.idp.local                 ║"
[[ "$SKIP_KAGENT"  == "false" ]] && echo "║                  http://localhost:8082 (port-forward)    ║"
echo "║  Model           Claude Haiku (Anthropic API)            ║"
echo "║  Backstage       http://localhost:3000/create             ║"
[[ "$SKIP_KAGENT"  == "false" ]] && echo "║                  → 'AI Agent (KAgent)' template          ║"
[[ "$SKIP_MLFLOW"  == "false" ]] && echo "║                  → 'ML Experiment (MLflow)' template     ║"
echo "╚══════════════════════════════════════════════════════════╝"
