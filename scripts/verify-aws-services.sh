#!/bin/bash
# Verify all AWS services are accessible and responding correctly

set -e

echo "🔍 AWS IDP Platform Service Verification"
echo "========================================"
echo

# Get ALB URLs from ingresses
echo "📍 Fetching ALB DNS names from ingresses..."
BACKSTAGE_URL=$(kubectl get ingress -n backstage backstage-ingress -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || echo "NOT_FOUND")
GRAFANA_URL=$(kubectl get ingress -n monitoring prometheus-grafana -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || echo "NOT_FOUND")
PROMETHEUS_URL=$(kubectl get ingress -n monitoring prometheus-kube-prometheus-prometheus -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || echo "NOT_FOUND")
ALERTMANAGER_URL=$(kubectl get ingress -n monitoring prometheus-kube-prometheus-alertmanager -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || echo "NOT_FOUND")

echo "✅ Ingress URLs:"
echo "  Backstage:    http://${BACKSTAGE_URL:-<not-configured>}"
echo "  Grafana:      http://${GRAFANA_URL:-<not-configured>}"
echo "  Prometheus:   http://${PROMETHEUS_URL:-<not-configured>}"
echo "  AlertManager: http://${ALERTMANAGER_URL:-<not-configured>}"
echo

# Check pod health
echo "🏥 Pod Health Status"
echo "==================="

echo "📊 Monitoring namespace:"
kubectl get pods -n monitoring | tail -n +2 | awk '{
  status = $3;
  ready = $2;
  if (status ~ /Running|Succeeded/) {
    print "  ✅ " $1 " (" ready ")";
  } else {
    print "  ❌ " $1 " (" status ")";
  }
}'

echo
echo "🚀 Backstage namespace:"
kubectl get pods -n backstage 2>/dev/null | tail -n +2 | awk '{
  status = $3;
  ready = $2;
  if (status ~ /Running|Succeeded/) {
    print "  ✅ " $1 " (" ready ")";
  } else {
    print "  ❌ " $1 " (" status ")";
  }
}' || echo "  ⚠️  Backstage namespace not found"

echo
echo "🔧 ArgoCD namespace:"
kubectl get pods -n argocd 2>/dev/null | tail -n +2 | awk '{
  status = $3;
  ready = $2;
  if (status ~ /Running|Succeeded/) {
    print "  ✅ " $1 " (" ready ")";
  } else {
    print "  ❌ " $1 " (" status ")";
  }
}' || echo "  ⚠️  ArgoCD namespace not found"

echo
echo "🌐 Service Connectivity Tests"
echo "============================"

test_url() {
  local url=$1
  local name=$2

  if [ "$url" = "NOT_FOUND" ] || [ -z "$url" ]; then
    echo "  ⏭️  $name: URL not configured"
    return 0
  fi

  local http_code=$(curl -s -o /dev/null -w "%{http_code}" "http://$url" --max-time 5 2>/dev/null || echo "000")

  if [ "$http_code" -ge 200 ] && [ "$http_code" -lt 400 ]; then
    echo "  ✅ $name: HTTP $http_code"
  elif [ "$http_code" -eq 503 ] || [ "$http_code" -eq 502 ]; then
    echo "  ⚠️  $name: HTTP $http_code (service initializing)"
  else
    echo "  ❌ $name: HTTP $http_code"
  fi
}

test_url "$BACKSTAGE_URL" "Backstage"
test_url "$GRAFANA_URL" "Grafana"
test_url "$PROMETHEUS_URL" "Prometheus"
test_url "$ALERTMANAGER_URL" "AlertManager"

echo
echo "📋 Cluster Resources"
echo "==================="
echo "  Nodes:"
kubectl get nodes | tail -n +2 | awk '{print "    " $1 ": " $5}'
echo
echo "  Namespaces:"
kubectl get ns | tail -n +2 | awk '{print "    " $1}'

echo
echo "✅ Verification complete!"
echo
echo "📌 Next Steps:"
echo "  1. If any services are unavailable, check pod logs:"
echo "     kubectl logs -n <namespace> <pod-name>"
echo "  2. If Grafana is not ready, wait 1-2 minutes for datasource provisioning"
echo "  3. Use the AWS ALB URLs above to access services"
