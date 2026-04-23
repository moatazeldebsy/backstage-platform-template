#!/usr/bin/env bash
# apply-catalog-exporter.sh
# Deploy the Backstage catalog exporter to the cluster (local Kind or AWS EKS).
# Run from the repo root.
#
# Usage:
#   ./scripts/apply-catalog-exporter.sh              # uses current kubectl context
#   ./scripts/apply-catalog-exporter.sh --context kind-kind
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTEXT_FLAG=""
if [[ "${1:-}" == "--context" ]]; then
  CONTEXT_FLAG="--context $2"
fi

echo "==> Creating/updating ConfigMap from exporter.py..."
kubectl $CONTEXT_FLAG create configmap backstage-catalog-exporter-script \
  --from-file=exporter.py="${REPO_ROOT}/observability/backstage-catalog-exporter/exporter.py" \
  -n monitoring \
  --dry-run=client -o yaml | kubectl $CONTEXT_FLAG apply -f -

echo "==> Applying CronJob + ServiceAccount..."
kubectl $CONTEXT_FLAG apply -f "${REPO_ROOT}/observability/backstage-catalog-exporter/cronjob.yaml"

echo "==> Updating Grafana dashboard ConfigMap..."
# Re-import the dashboard JSON so Grafana picks up the new $service variable
if kubectl $CONTEXT_FLAG get configmap grafana-dashboards-idp -n monitoring &>/dev/null; then
  kubectl $CONTEXT_FLAG create configmap grafana-dashboards-idp \
    --from-file=hello-service.json="${REPO_ROOT}/observability/grafana/dashboards/hello-service.json" \
    -n monitoring \
    --dry-run=client -o yaml | kubectl $CONTEXT_FLAG apply -f -
  echo "==> Restarting Grafana to pick up new dashboard..."
  GRAFANA_DEPLOY=$(kubectl $CONTEXT_FLAG get deployment -n monitoring -o name 2>/dev/null | grep -i grafana | head -1)
  if [[ -n "$GRAFANA_DEPLOY" ]]; then
    kubectl $CONTEXT_FLAG rollout restart "$GRAFANA_DEPLOY" -n monitoring
  else
    echo "    Could not find Grafana deployment — skipping restart"
  fi
else
  echo "    grafana-dashboards-idp ConfigMap not found — skipping (Grafana may pick up dashboards differently in this environment)"
fi

echo ""
echo "Done. CronJob will fire within 5 minutes."
echo "To trigger immediately:"
echo "  kubectl $CONTEXT_FLAG create job --from=cronjob/backstage-catalog-exporter catalog-sync-now -n monitoring"
