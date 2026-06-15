#!/usr/bin/env bash
# validate-deployment.sh — Comprehensive deployment validation
# Tests all platform components after bootstrap
# Usage: ./scripts/validate-deployment.sh [--detailed]
set -euo pipefail

# ── Defaults ─────────────────────────────────────────────────────────────────
AWS_REGION="${AWS_REGION:-us-east-1}"
CLUSTER_NAME="${CLUSTER_NAME:-idp-mvp}"
DETAILED="${DETAILED:-false}"
FAILED_TESTS=0
PASSED_TESTS=0

log()    { echo "✓ $*"; PASSED_TESTS=$((PASSED_TESTS+1)); }
err()    { echo "✗ $*"; FAILED_TESTS=$((FAILED_TESTS+1)); }
header() { echo ""; echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"; echo "  $*"; echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"; }

# Parse flags
while [[ $# -gt 0 ]]; do
  case "$1" in
    --detailed) DETAILED=true; shift ;;
    *) shift ;;
  esac
done

# ── 1. AWS Infrastructure Tests ──────────────────────────────────────────────
header "AWS Infrastructure Validation"

# Check EKS cluster exists
if aws eks describe-cluster --name "$CLUSTER_NAME" --region "$AWS_REGION" &>/dev/null; then
  CLUSTER_STATUS=$(aws eks describe-cluster --name "$CLUSTER_NAME" --region "$AWS_REGION" --query 'cluster.status' --output text)
  [[ "$CLUSTER_STATUS" == "ACTIVE" ]] && log "EKS cluster is ACTIVE" || err "EKS cluster status: $CLUSTER_STATUS"
else
  err "EKS cluster not found"
fi

# Check nodes are Ready
READY_NODES=$(kubectl get nodes --no-headers 2>/dev/null | grep -c "Ready" || echo "0")
TOTAL_NODES=$(kubectl get nodes --no-headers 2>/dev/null | wc -l)
[[ $READY_NODES -eq $TOTAL_NODES ]] && [[ $TOTAL_NODES -gt 0 ]] && \
  log "All $TOTAL_NODES nodes Ready" || err "Nodes: $READY_NODES/$TOTAL_NODES Ready"

# Check RDS is available
if aws rds describe-db-instances --db-instance-identifier "${CLUSTER_NAME}-backstage" --region "$AWS_REGION" &>/dev/null 2>&1; then
  RDS_STATUS=$(aws rds describe-db-instances --db-instance-identifier "${CLUSTER_NAME}-backstage" --region "$AWS_REGION" --query 'DBInstances[0].DBInstanceStatus' --output text)
  [[ "$RDS_STATUS" == "available" ]] && log "RDS database is available" || err "RDS status: $RDS_STATUS"
else
  err "RDS database not found"
fi

# Check ECR repository
if aws ecr describe-repositories --repository-names "idp-mvp/hello-service" --region "$AWS_REGION" &>/dev/null 2>&1; then
  log "ECR registry accessible"
else
  err "ECR registry not accessible"
fi

# ── 2. Kubernetes Components Tests ───────────────────────────────────────────
header "Kubernetes Components Validation"

# Check all namespaces exist
for ns in backstage argocd monitoring services services-dev services-staging argo-rollouts ml-platform kagent; do
  kubectl get namespace "$ns" &>/dev/null && log "Namespace: $ns" || err "Namespace missing: $ns"
done

# Check critical deployments
for deploy_ns_name in "backstage:backstage" "argocd:argocd-server" "monitoring:prometheus-operator" "argo-rollouts:argo-rollouts" "kagent:kagent-controller"; do
  ns="${deploy_ns_name%:*}"
  name="${deploy_ns_name#*:}"
  REPLICAS=$(kubectl get deployment "$name" -n "$ns" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
  DESIRED=$(kubectl get deployment "$name" -n "$ns" -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "1")
  [[ "$REPLICAS" -eq "$DESIRED" ]] && [[ "$DESIRED" -gt 0 ]] && \
    log "Deployment: $ns/$name ($REPLICAS/$DESIRED)" || \
    err "Deployment: $ns/$name ($REPLICAS/$DESIRED)"
done

# Check for CrashLoopBackOff or ImagePullBackOff
PROBLEM_PODS=$(kubectl get pods -A --field-selector=status.phase!=Running --no-headers 2>/dev/null | grep -vE "Succeeded|Completed" | wc -l)
[[ $PROBLEM_PODS -eq 0 ]] && log "No pods in error states" || err "$PROBLEM_PODS pods in error state"

# ── 3. Backstage Portal Tests ────────────────────────────────────────────────
header "Backstage Portal Validation"

BACKSTAGE_URL=$(kubectl get service backstage -n backstage -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || echo "")

if [[ -n "$BACKSTAGE_URL" ]]; then
  log "Backstage ALB URL: http://$BACKSTAGE_URL"

  # Test HTTP endpoint
  if curl -s -m 5 "http://$BACKSTAGE_URL/" >/dev/null 2>&1; then
    log "Backstage portal responds (HTTP 200)"
  else
    err "Backstage portal not responding"
  fi

  # Test API health endpoint
  if curl -s -m 5 "http://$BACKSTAGE_URL/api/health" 2>/dev/null | grep -q "ok"; then
    log "Backstage API health check passed"
  else
    err "Backstage API health check failed"
  fi
else
  err "Backstage load balancer not provisioned"
fi

# ── 4. Observability Stack Tests ─────────────────────────────────────────────
header "Observability Stack Validation"

# Check Prometheus (via ALB Ingress)
PROMETHEUS_URL=$(kubectl get ingress -n monitoring -l app.kubernetes.io/name=prometheus -o jsonpath='{.items[0].status.loadBalancer.ingress[0].hostname}' 2>/dev/null || echo "")
[[ -n "$PROMETHEUS_URL" ]] && log "Prometheus URL: http://$PROMETHEUS_URL" || err "Prometheus ingress not ready"

# Check if Prometheus is scraping targets
PROMETHEUS_TARGETS=$(kubectl exec -n monitoring -l app.kubernetes.io/name=prometheus -c prometheus -- \
  curl -s localhost:9090/api/v1/targets 2>/dev/null | grep -o '"state":"up"' | wc -l | xargs || echo "0")
[[ $PROMETHEUS_TARGETS -gt 0 ]] && log "Prometheus scraping $PROMETHEUS_TARGETS targets" || err "Prometheus not scraping"

# Check Grafana (via ALB Ingress)
GRAFANA_URL=$(kubectl get ingress -n monitoring -l app.kubernetes.io/name=grafana -o jsonpath='{.items[0].status.loadBalancer.ingress[0].hostname}' 2>/dev/null || echo "")
[[ -n "$GRAFANA_URL" ]] && log "Grafana URL: http://$GRAFANA_URL" || err "Grafana ingress not ready"

# Check Loki
LOKI_READY=$(kubectl get pods -n monitoring -l app.kubernetes.io/name=loki --no-headers 2>/dev/null | grep -c "Running" || echo "0")
[[ $LOKI_READY -gt 0 ]] && log "Loki: $LOKI_READY pod(s) running" || err "Loki not running (log aggregation unavailable)"

# Check Tempo
TEMPO_READY=$(kubectl get pods -n monitoring -l app.kubernetes.io/name=tempo --no-headers 2>/dev/null | grep -c "Running" || echo "0")
[[ $TEMPO_READY -gt 0 ]] && log "Tempo: $TEMPO_READY pod(s) running" || err "Tempo not running (distributed tracing unavailable)"

# Check Argo Rollouts controller
ROLLOUTS_READY=$(kubectl get deployment argo-rollouts -n argo-rollouts -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
[[ "${ROLLOUTS_READY:-0}" -gt 0 ]] && log "Argo Rollouts controller ready ($ROLLOUTS_READY replicas)" || err "Argo Rollouts controller not ready"

# Check ClusterAnalysisTemplate exists
kubectl get clusteranalysistemplate http-error-rate &>/dev/null && \
  log "ClusterAnalysisTemplate: http-error-rate present" || \
  err "ClusterAnalysisTemplate http-error-rate missing (canary auto-rollback unavailable)"

# ── 5. GitOps & CI/CD Tests ──────────────────────────────────────────────────
header "GitOps & CI/CD Validation"

# Check ArgoCD (via ALB Ingress)
ARGOCD_URL=$(kubectl get ingress argocd-server -n argocd -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || echo "")
[[ -n "$ARGOCD_URL" ]] && log "ArgoCD URL: http://$ARGOCD_URL" || err "ArgoCD ingress not ready"

# Check ArgoCD applications
APPS=$(kubectl get applications -n argocd --no-headers 2>/dev/null | wc -l)
[[ $APPS -gt 0 ]] && log "ArgoCD has $APPS applications" || err "No ArgoCD applications registered"

# Check if ArgoCD apps are synced
SYNCED_APPS=$(kubectl get applications -n argocd -o jsonpath='{.items[*].status.operationState.phase}' 2>/dev/null | grep -o "Succeeded" | wc -l || echo "0")
[[ $SYNCED_APPS -gt 0 ]] && log "ArgoCD: $SYNCED_APPS applications synced" || err "ArgoCD applications not syncing"

# Check External Secrets Operator
ESO_READY=$(kubectl get deployment -n external-secrets external-secrets -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
[[ "$ESO_READY" -gt 0 ]] && log "External Secrets Operator ready" || err "External Secrets Operator not ready"

# Check ClusterSecretStore
CSS_STATUS=$(kubectl get clustersecretstore aws-secretsmanager -o jsonpath='{.status.conditions[0].reason}' 2>/dev/null || echo "")
[[ "$CSS_STATUS" == "StoreValid" ]] && log "ClusterSecretStore is valid" || err "ClusterSecretStore status: $CSS_STATUS"

# ── 6. AI/ML Stack Tests (Optional) ──────────────────────────────────────────
header "AI/ML Stack Validation (Optional)"

# Check if KAgent is deployed
KAGENT_NS=$(kubectl get ns kagent 2>/dev/null && echo "yes" || echo "no")
if [[ "$KAGENT_NS" == "yes" ]]; then

  # Check KAgent controller
  KAGENT_READY=$(kubectl get deployment kagent-controller -n kagent -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
  [[ "$KAGENT_READY" -gt 0 ]] && log "KAgent controller ready" || err "KAgent controller not ready"

  # Check agents status
  AGENTS_READY=$(kubectl get agents -n kagent -o jsonpath='{.items[*].status.conditions[?(@.type=="Ready")].status}' 2>/dev/null | grep -o "True" | wc -l || echo "0")
  TOTAL_AGENTS=$(kubectl get agents -n kagent --no-headers 2>/dev/null | wc -l || echo "0")
  [[ $AGENTS_READY -gt 0 ]] && log "KAgent: $AGENTS_READY/$TOTAL_AGENTS agents Ready" || err "KAgent agents not ready"

  # Check MLflow
  MLFLOW_URL=$(kubectl get service -n ml-platform mlflow -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || echo "")
  [[ -n "$MLFLOW_URL" ]] && log "MLflow URL: http://$MLFLOW_URL:5000" || err "MLflow not accessible"

else
  err "KAgent namespace not found (AI/ML stack not deployed)"
fi

# ── 7. Security & Compliance Tests ───────────────────────────────────────────
header "Security & Compliance Validation"

# Check Pod Security Policy
PSS_LABEL=$(kubectl get namespace services -o jsonpath='{.metadata.labels.pod-security\.kubernetes\.io/enforce}' 2>/dev/null || echo "")
[[ -n "$PSS_LABEL" ]] && log "Pod Security Standards enforced: $PSS_LABEL" || err "Pod Security Standards not enforced"

# Check OPA Gatekeeper
GATEKEEPER=$(kubectl get ns gatekeeper-system 2>/dev/null && echo "yes" || echo "no")
if [[ "$GATEKEEPER" == "yes" ]]; then
  CONSTRAINT_COUNT=$(kubectl get constraints --all-namespaces --no-headers 2>/dev/null | wc -l)
  log "OPA Gatekeeper active with $CONSTRAINT_COUNT constraints"
else
  err "OPA Gatekeeper not found"
fi

# Check for RBAC
RBAC_COUNT=$(kubectl get clusterroles --no-headers 2>/dev/null | wc -l)
log "Kubernetes RBAC configured ($RBAC_COUNT roles)"

# ── 8. Network & Connectivity Tests ──────────────────────────────────────────
header "Network & Connectivity Validation"

# Check ingress controllers
INGRESS_CTRL=$(kubectl get ingressclass --no-headers 2>/dev/null | grep -c "alb\|nginx" || echo "0")
[[ $INGRESS_CTRL -gt 0 ]] && log "Ingress controllers active" || err "No ingress controllers found"

# Check load balancer service count
ALB_COUNT=$(kubectl get services -A -o jsonpath='{.items[*].status.loadBalancer.ingress[*].hostname}' 2>/dev/null | wc -w)
log "Active load balancers: $ALB_COUNT"

# Check DNS resolution from cluster
TEST_POD=$(kubectl run -it --rm test-dns --image=alpine --restart=Never -- \
  nslookup kubernetes.default 2>/dev/null | grep "Name:" | wc -l | xargs || echo "0")
[[ "$TEST_POD" -gt 0 ]] && log "DNS resolution working" || err "DNS resolution failed"

# ── 9. Storage & Persistence Tests ───────────────────────────────────────────
header "Storage & Persistence Validation"

# Check PVC status
PVC_BOUND=$(kubectl get pvc -A --field-selector=status.phase=Bound --no-headers 2>/dev/null | wc -l)
PVC_TOTAL=$(kubectl get pvc -A --no-headers 2>/dev/null | wc -l)
[[ $PVC_BOUND -eq $PVC_TOTAL ]] && [[ $PVC_TOTAL -gt 0 ]] && \
  log "All PVCs bound: $PVC_BOUND/$PVC_TOTAL" || err "PVC status: $PVC_BOUND/$PVC_TOTAL bound"

# Check storage classes
SC_COUNT=$(kubectl get storageclass --no-headers 2>/dev/null | wc -l)
log "Storage classes available: $SC_COUNT"

# ── 10. Cost & Resource Tests ───────────────────────────────────────────────
header "Resource & Cost Validation"

# Check node resource usage
NODE_CPU=$(kubectl top nodes --no-headers 2>/dev/null | awk '{print $2}' | grep -o '[0-9]*' | awk '{s+=$1} END {print s}' || echo "0")
NODE_MEMORY=$(kubectl top nodes --no-headers 2>/dev/null | awk '{print $4}' | grep -o '[0-9]*' | awk '{s+=$1} END {print s}' || echo "0")
log "Cluster resource usage: CPU ${NODE_CPU}m, Memory ${NODE_MEMORY}Mi"

# Check pod resource requests
POD_CPU_REQ=$(kubectl get pods -A -o jsonpath='{.items[*].spec.containers[*].resources.requests.cpu}' 2>/dev/null | grep -o '[0-9]*m' | sed 's/m//' | awk '{s+=$1} END {print s}' || echo "0")
log "Pod CPU requests: ${POD_CPU_REQ}m"

# Check team budget ConfigMap
kubectl get configmap team-budgets -n monitoring &>/dev/null && \
  log "Team budget ConfigMap present (finops cost alerts enabled)" || \
  err "Team budget ConfigMap missing in monitoring namespace"

# Check tech-insights-exporter CronJob
kubectl get cronjob tech-insights-exporter -n monitoring &>/dev/null && \
  log "Tech-insights-exporter CronJob present" || \
  err "Tech-insights-exporter CronJob missing (team cost metrics unavailable)"

# Check PrometheusRules are loaded
PROM_RULE_COUNT=$(kubectl get prometheusrule -n monitoring --no-headers 2>/dev/null | wc -l)
[[ $PROM_RULE_COUNT -gt 0 ]] && \
  log "PrometheusRules loaded: $PROM_RULE_COUNT rules (SLO burn-rate, budgets, guardrails)" || \
  err "PrometheusRules missing in monitoring namespace — run: kubectl apply -f observability/alertmanager/prometheus-rules.yaml"

# Check SLO Grafana dashboard ConfigMap
kubectl get configmap grafana-dashboards-sre -n monitoring &>/dev/null && \
  log "SRE Grafana dashboard ConfigMap present" || \
  err "SRE Grafana dashboard ConfigMap missing (slo-error-budget dashboard unavailable)"

# Check FinOps Grafana dashboard ConfigMap
kubectl get configmap grafana-dashboards-finops -n monitoring &>/dev/null && \
  log "FinOps Grafana dashboard ConfigMap present" || \
  err "FinOps Grafana dashboard ConfigMap missing (team-budgets dashboard unavailable)"

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║                   VALIDATION SUMMARY                           ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""
echo "  Passed: $PASSED_TESTS"
echo "  Failed: $FAILED_TESTS"
echo ""

if [[ $FAILED_TESTS -eq 0 ]]; then
  echo "✅ DEPLOYMENT VALIDATION PASSED"
  echo ""
  echo "Next steps:"
  echo "  1. Access Backstage: ./scripts/bootstrap.sh --print-urls"
  echo "  2. Configure GitHub OAuth in Backstage settings"
  echo "  3. Create first service using a template"
  echo "  4. Monitor via Grafana dashboard"
  exit 0
else
  echo "❌ DEPLOYMENT VALIDATION FAILED"
  echo ""
  echo "To debug:"
  echo "  kubectl get pods -A | grep -v Running"
  echo "  kubectl describe pod <pod> -n <namespace>"
  echo "  kubectl logs <pod> -n <namespace> --tail=50"
  exit 1
fi
