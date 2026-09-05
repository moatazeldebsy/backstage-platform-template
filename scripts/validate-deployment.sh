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

# Parse flags. Unknown flags used to be silently shifted away, so a typo like
# --detail ran the default validation and reported success for something the
# caller never asked for.
usage() {
  echo "Usage: $0 [--detailed]"
  echo "  --detailed   Print per-check detail instead of a summary."
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --detailed) DETAILED=true; shift ;;
    -h|--help)  usage; exit 0 ;;
    *) echo "✗ Unknown flag: $1" >&2; usage >&2; exit 2 ;;
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
# The Prometheus operator is named for its Helm release: kube-prometheus-stack
# installs it as prometheus-kube-prometheus-operator, not prometheus-operator.
# The old name matched nothing, so this reported a failed deployment on a
# cluster where the operator was healthy 1/1. Observed 2026-08-16.
for deploy_ns_name in "backstage:backstage" "argocd:argocd-server" "monitoring:prometheus-kube-prometheus-operator" "argo-rollouts:argo-rollouts" "kagent:kagent-controller"; do
  ns="${deploy_ns_name%:*}"
  name="${deploy_ns_name#*:}"
  REPLICAS=$(kubectl get deployment "$name" -n "$ns" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
  DESIRED=$(kubectl get deployment "$name" -n "$ns" -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "1")
  [[ "$REPLICAS" -eq "$DESIRED" ]] && [[ "$DESIRED" -gt 0 ]] && \
    log "Deployment: $ns/$name ($REPLICAS/$DESIRED)" || \
    err "Deployment: $ns/$name ($REPLICAS/$DESIRED)"
done

# Check for CrashLoopBackOff or ImagePullBackOff.
#
# The `|| true` is load-bearing under `set -euo pipefail`. Every non-Running pod
# on a healthy cluster is a Completed CronJob pod, so `grep -v` matches nothing
# and exits 1; pipefail propagates that out of the command substitution and
# `set -e` kills the script — right here, at check 20 of 34, before any summary
# is printed. The healthier the cluster, the more reliably this validator died.
# Observed on a fully-healthy idp-mvp, 2026-08-16.
PROBLEM_PODS=$(kubectl get pods -A --field-selector=status.phase!=Running --no-headers 2>/dev/null | grep -vcE "Succeeded|Completed" || true)
PROBLEM_PODS="${PROBLEM_PODS:-0}"
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
  # Backstage serves /healthcheck; /api/health is a 404 (it was never a
  # Backstage route), so this check failed on a portal that was serving fine.
  if curl -s -m 5 "http://$BACKSTAGE_URL/healthcheck" 2>/dev/null | grep -q "ok"; then
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
# Prometheus and AlertManager are deliberately NOT exposed through an ALB —
# only Grafana is. Requiring a public ingress here reported a failure for the
# safer configuration, and with no TLS on this platform yet (issue #310)
# publishing them would be worse. Check the in-cluster Service instead.
if kubectl get svc -n monitoring prometheus-kube-prometheus-prometheus &>/dev/null; then
  log "Prometheus Service reachable in-cluster (not publicly exposed, by design)"
else
  err "Prometheus Service not found"
fi

# Check if Prometheus is scraping targets
# Reached over a port-forward, not `kubectl exec`. Two earlier forms could
# never work: `kubectl exec` takes a pod NAME rather than a -l selector, and
# the Prometheus image is distroless — it has no sh, wget or curl to exec at
# all. The API-server service proxy hangs on this cluster. So: forward a local
# port, ask, and always tear the tunnel down. Observed 2026-08-16.
PROM_PF_PORT="${PROM_PF_PORT:-19090}"
PROMETHEUS_TARGETS=0
if kubectl get svc prometheus-kube-prometheus-prometheus -n monitoring &>/dev/null; then
  kubectl port-forward -n monitoring svc/prometheus-kube-prometheus-prometheus \
    "${PROM_PF_PORT}:9090" >/dev/null 2>&1 &
  PROM_PF_PID=$!
  # trap so an early exit cannot leave the tunnel behind
  trap 'kill "${PROM_PF_PID:-}" 2>/dev/null || true' EXIT
  # Poll rather than sleep a fixed interval: the tunnel takes a variable time to
  # come up, and a fixed `sleep 6` was enough when this block ran alone but not
  # when it ran as check 30 of 53 on a loaded machine — which reported
  # "Prometheus not scraping" for a Prometheus scraping 90 targets.
  for _ in $(seq 1 10); do
    curl -s -m 3 "http://localhost:${PROM_PF_PORT}/-/ready" >/dev/null 2>&1 && break
    sleep 2
  done
  PROMETHEUS_TARGETS=$(curl -s -m 15 "http://localhost:${PROM_PF_PORT}/api/v1/targets?state=active" 2>/dev/null \
    | grep -o '"health":"up"' | wc -l | tr -d " " || true)
  PROMETHEUS_TARGETS="${PROMETHEUS_TARGETS:-0}"
  kill "$PROM_PF_PID" 2>/dev/null || true
  trap - EXIT
fi
[[ $PROMETHEUS_TARGETS -gt 0 ]] && log "Prometheus scraping $PROMETHEUS_TARGETS targets" || err "Prometheus not scraping"

# Check Grafana (via ALB Ingress)
GRAFANA_URL=$(kubectl get ingress -n monitoring -l app.kubernetes.io/name=grafana -o jsonpath='{.items[0].status.loadBalancer.ingress[0].hostname}' 2>/dev/null || echo "")
[[ -n "$GRAFANA_URL" ]] && log "Grafana URL: http://$GRAFANA_URL" || err "Grafana ingress not ready"

# Check AlertManager (via ALB Ingress)
# Same as Prometheus above: in-cluster only, by design.
if kubectl get svc -n monitoring alertmanager-operated &>/dev/null; then
  log "AlertManager Service reachable in-cluster (not publicly exposed, by design)"
else
  err "AlertManager Service not found"
fi

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
# External Secrets reports the reason as "Valid"; "StoreValid" is the condition
# TYPE, not the reason. The old comparison never matched, so a healthy store
# failed with the message "ClusterSecretStore status: Valid".
case "$CSS_STATUS" in
  Valid|StoreValid) log "ClusterSecretStore is valid ($CSS_STATUS)" ;;
  *)               err "ClusterSecretStore status: ${CSS_STATUS:-unknown}" ;;
esac

# ── 6. AI/ML Stack Tests (Optional) ──────────────────────────────────────────
header "AI/ML Stack Validation (Optional)"

# Check if KAgent is deployed
# `$(kubectl get ns X && echo yes)` captures kubectl's output table AND the
# "yes", so the variable never equals "yes" and this branch never ran: the
# whole AI/ML section reported "not deployed" on a cluster where kagent was
# Active. Test the exit status directly. Observed 2026-08-16.
if kubectl get ns kagent &>/dev/null; then

  # Check KAgent controller
  KAGENT_READY=$(kubectl get deployment kagent-controller -n kagent -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
  [[ "$KAGENT_READY" -gt 0 ]] && log "KAgent controller ready" || err "KAgent controller not ready"

  # Check agents status
  AGENTS_READY=$(kubectl get agents -n kagent -o jsonpath='{.items[*].status.conditions[?(@.type=="Ready")].status}' 2>/dev/null | grep -o "True" | wc -l || echo "0")
  TOTAL_AGENTS=$(kubectl get agents -n kagent --no-headers 2>/dev/null | wc -l || echo "0")
  [[ $AGENTS_READY -gt 0 ]] && log "KAgent: $AGENTS_READY/$TOTAL_AGENTS agents Ready" || err "KAgent agents not ready"

  # Check MLflow
  # MLflow is exposed through an ALB *Ingress*; its Service is ClusterIP, so
  # reading a loadBalancer hostname off the Service always came back empty.
  MLFLOW_URL=$(kubectl get ingress -n ml-platform mlflow -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || echo "")
  [[ -n "$MLFLOW_URL" ]] && log "MLflow URL: http://$MLFLOW_URL" || err "MLflow not accessible"

  # Check the AI Gateway. It is deployed BY DEFAULT (disable with
  # bootstrap-ai.sh --skip-gateway), and every agent's single RemoteMCPServer
  # plus every ModelConfig's anthropic.baseUrl point at it — so a cluster
  # missing it has agents with neither tools nor a model. That is a real
  # failure, not a supported shape, and is reported as one.
  if kubectl get deployment ai-gateway -n ml-platform &>/dev/null; then
    GW_READY=$(kubectl get deployment ai-gateway -n ml-platform -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
    [[ "${GW_READY:-0}" -gt 0 ]] && log "AI Gateway ready" || err "AI Gateway deployed but not ready"

    # Ready is not the same as useful: failureMode is failOpen, so the gateway
    # serves happily while silently missing the tools of any target it cannot
    # reach. Count the targets that actually resolve.
    GW_TARGETS=0
    for t in idp:3001 qa:3002 contract:3003 github:3005 argocd:3006 cost:3007 incident:3008 security:3010; do
      kubectl get service "${t%%:*}-mcp-server" -n services-dev &>/dev/null && GW_TARGETS=$((GW_TARGETS+1))
    done
    log "AI Gateway MCP targets resolvable: $GW_TARGETS/8 (incident+security need --adp)"

    # Model egress runs through the same gateway (modelconfig*.yaml points
    # anthropic.baseUrl at it). Without the key the gateway is still healthy and
    # tools still work, so this cannot be inferred from readyReplicas.
    if kubectl get secret ai-gateway-llm-keys -n ml-platform &>/dev/null; then
      log "AI Gateway LLM credentials present (ai-gateway-llm-keys)"
    else
      err "AI Gateway has no ai-gateway-llm-keys secret — agent model calls will 401"
    fi
  else
    err "AI Gateway not installed — agents have no tools and no model. Run bootstrap-ai.sh (it is on by default; --skip-gateway is the opt-out)."
  fi

else
  err "KAgent namespace not found (AI/ML stack not deployed)"
fi

# ── 7. Security & Compliance Tests ───────────────────────────────────────────
header "Security & Compliance Validation"

# Check Pod Security Policy
PSS_LABEL=$(kubectl get namespace services -o jsonpath='{.metadata.labels.pod-security\.kubernetes\.io/enforce}' 2>/dev/null || echo "")
[[ -n "$PSS_LABEL" ]] && log "Pod Security Standards enforced: $PSS_LABEL" || err "Pod Security Standards not enforced"

# Check OPA Gatekeeper
# Same capture bug as the kagent check above.
if kubectl get ns gatekeeper-system &>/dev/null; then
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
# `wc -l | xargs || echo 0` can emit two values, giving `[[: 0\n0: syntax
# error`. `-it` also requires a TTY, which a CI or nohup run does not have.
if kubectl run test-dns --rm --attach --restart=Never --quiet \
     --image=public.ecr.aws/docker/library/busybox:1.36 \
     --command -- nslookup kubernetes.default.svc.cluster.local 2>/dev/null | grep -q "Address"; then
  # The FQDN is deliberate: busybox nslookup does not apply the pod's search
  # suffixes, so the short name "kubernetes.default" returns NXDOMAIN even
  # though cluster DNS is working perfectly.
  log "DNS resolution working"
else
  err "DNS resolution failed"
fi

# ── 9. Storage & Persistence Tests ───────────────────────────────────────────
header "Storage & Persistence Validation"

# Check PVC status.
#
# PVCs do NOT support status.phase as a field selector — the API server allows
# only metadata.name and metadata.namespace and answers BadRequest. 2>/dev/null
# hid the error, kubectl still exited non-zero, and pipefail killed the script
# here, so this section and everything after it never ran. Filter client-side.
# Observed 2026-08-16.
PVC_BOUND=$(kubectl get pvc -A --no-headers 2>/dev/null | grep -c "Bound" || true)
PVC_BOUND="${PVC_BOUND:-0}"
PVC_TOTAL=$(kubectl get pvc -A --no-headers 2>/dev/null | wc -l | tr -d ' ')
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
  # bootstrap.sh has no --print-urls (that flag is bootstrap-local.sh only), so
  # the old hint here died with "Unknown flag". Read the hostname directly.
  echo "  1. Access Backstage: http://$(kubectl get svc backstage -n backstage \
       -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || echo '<pending>')"
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
