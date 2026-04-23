#!/usr/bin/env bash
# seed-qa-metrics.sh — Push sample QA metrics to the local Pushgateway
# so the "QA Platform Metrics" Grafana dashboard shows data immediately.
#
# Usage:
#   ./scripts/seed-qa-metrics.sh                     # uses pushgateway.idp.local
#   PUSHGATEWAY_URL=http://localhost:9091 ./scripts/seed-qa-metrics.sh
#
# To push via port-forward instead of ingress:
#   kubectl port-forward svc/prometheus-pushgateway 9091:9091 -n monitoring &
#   PUSHGATEWAY_URL=http://localhost:9091 ./scripts/seed-qa-metrics.sh
set -euo pipefail

PUSHGATEWAY_URL="${PUSHGATEWAY_URL:-http://pushgateway.idp.local}"

log() { echo "[$(date +%T)] $*"; }

push() {
  local job="$1" suite="$2"
  shift 2
  printf '%s\n' "$@" | curl -sf --data-binary @- \
    "${PUSHGATEWAY_URL}/metrics/job/${job}/suite/${suite}" \
    || { echo "ERROR: could not reach ${PUSHGATEWAY_URL} — is Pushgateway running?"; exit 1; }
}

log "Pushing sample QA metrics to ${PUSHGATEWAY_URL}..."

# ── E2E metrics (hello-service) ───────────────────────────────────────────────
push e2e hello-service-e2e \
  "# TYPE e2e_tests_total gauge" \
  'e2e_tests_total{suite="hello-service-e2e",result="passed"} 24' \
  'e2e_tests_total{suite="hello-service-e2e",result="failed"} 2' \
  "# TYPE e2e_pass_rate gauge" \
  'e2e_pass_rate{suite="hello-service-e2e"} 0.923'

# ── k6 performance metrics (hello-service) ───────────────────────────────────
push performance hello-service-perf \
  "# TYPE perf_http_req_duration_p95_ms gauge" \
  'perf_http_req_duration_p95_ms{suite="hello-service-perf"} 142' \
  "# TYPE perf_http_error_rate gauge" \
  'perf_http_error_rate{suite="hello-service-perf"} 0.004' \
  "# TYPE perf_http_requests_total gauge" \
  'perf_http_requests_total{suite="hello-service-perf"} 3600'

log "Done. Open Grafana → QA Platform Metrics dashboard."
log "Grafana: http://grafana.idp.local  (admin / admin)"
