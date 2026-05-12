#!/usr/bin/env bash
# apply-catalog-exporter.sh — Deploy the Backstage catalog exporter CronJob.
# Queries the Backstage catalog API every 15 min and pushes two metric families
# to the Prometheus Pushgateway:
#   - backstage_catalog_entities_total   (count by kind)
#   - backstage_catalog_service_info     (info metric per Component, with labels)
#
# Prerequisites:
#   - Kind cluster running with 'monitoring' namespace
#   - Backstage reachable at backstage.default.svc.cluster.local:7007 (in-cluster)
#   - Prometheus Pushgateway running in the monitoring namespace
#
# Usage:
#   ./scripts/apply-catalog-exporter.sh
#   # Force an immediate run after deploying:
#   kubectl create job catalog-exporter-now --from=cronjob/catalog-exporter -n monitoring
set -euo pipefail

NAMESPACE="monitoring"
BACKSTAGE_URL="http://backstage.backstage.svc.cluster.local:7007"
PUSHGATEWAY_URL="http://prometheus-pushgateway.monitoring.svc.cluster.local:9091"
CATALOG_TOKEN="local-catalog-exporter-token"

log()  { echo "[$(date +%T)] INFO  $*"; }
warn() { echo "[$(date +%T)] WARN  $*"; }

if ! kubectl get namespace "${NAMESPACE}" &>/dev/null; then
  warn "Namespace '${NAMESPACE}' not found. Run bootstrap-local.sh first."
  exit 1
fi

log "Deploying catalog exporter to namespace ${NAMESPACE}..."

kubectl apply -f - <<'MANIFEST_END'
apiVersion: batch/v1
kind: CronJob
metadata:
  name: catalog-exporter
  namespace: monitoring
  labels:
    app.kubernetes.io/name: catalog-exporter
    app.kubernetes.io/component: observability
spec:
  schedule: "*/15 * * * *"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 1
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          initContainers:
            - name: install-deps
              image: python:3.11-slim
              command: [pip, install, --quiet, --target=/deps, requests]
              resources:
                requests: { cpu: 100m, memory: 64Mi }
                limits:   { cpu: 200m, memory: 128Mi }
              volumeMounts:
                - name: deps
                  mountPath: /deps
          containers:
            - name: exporter
              image: python:3.11-slim
              env:
                - name: PYTHONPATH
                  value: /deps
                - name: BACKSTAGE_URL
                  value: http://backstage.backstage.svc.cluster.local:7007
                - name: CATALOG_TOKEN
                  value: local-catalog-exporter-token
                - name: PUSHGATEWAY_URL
                  value: http://prometheus-pushgateway.monitoring.svc.cluster.local:9091
              command:
                - python3
                - -c
                - |
                  import os, sys, requests, logging

                  logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
                  log = logging.getLogger(__name__)

                  BACKSTAGE   = os.environ["BACKSTAGE_URL"]
                  TOKEN       = os.environ["CATALOG_TOKEN"]
                  PUSHGATEWAY = os.environ["PUSHGATEWAY_URL"]
                  HEADERS     = {"Authorization": f"Bearer {TOKEN}"}

                  def push_put(url, metrics_text):
                      resp = requests.put(url, data=metrics_text.encode(),
                                          headers={"Content-Type": "text/plain"},
                                          timeout=15)
                      resp.raise_for_status()

                  # Fetch all entities
                  resp = requests.get(f"{BACKSTAGE}/api/catalog/entities?limit=500",
                                      headers=HEADERS, timeout=30)
                  resp.raise_for_status()
                  entities = resp.json()

                  # --- metric 1: entity counts by kind ---
                  # Push one group per kind (same URL scheme as the original shell script)
                  # so we don't create duplicate series across groups.
                  counts = {}
                  for e in entities:
                      kind = e.get("kind", "Unknown")
                      counts[kind] = counts.get(kind, 0) + 1
                  counts["all"] = len(entities)

                  for kind, n in counts.items():
                      text = (f"# HELP backstage_catalog_entities_total Total entities by kind\n"
                              f"# TYPE backstage_catalog_entities_total gauge\n"
                              f'backstage_catalog_entities_total{{kind="{kind}"}} {n}\n')
                      push_put(f"{PUSHGATEWAY}/metrics/job/catalog-exporter/instance/backstage/kind/{kind}", text)
                  log.info("Pushed entity counts: %s", counts)

                  # --- metric 2: per-Component service info (separate job to avoid conflicts) ---
                  # PUT replaces the whole group, so a single push keeps service list current.
                  components = [e for e in entities if e.get("kind") == "Component"]
                  info_lines = ["# HELP backstage_catalog_service_info Backstage catalog Component info (value always 1)",
                                "# TYPE backstage_catalog_service_info gauge"]
                  for comp in components:
                      meta = comp.get("metadata", {})
                      spec = comp.get("spec", {})
                      name       = meta.get("name", "unknown")
                      raw_owner  = spec.get("owner", "")
                      owner      = raw_owner.split("/")[-1] if "/" in raw_owner else raw_owner
                      lifecycle  = spec.get("lifecycle", "unknown")
                      system     = spec.get("system", "unknown")
                      cost_center = meta.get("annotations", {}).get("cost-center") or ""
                      labels = (f'name="{name}",owner="{owner}",'
                                f'lifecycle="{lifecycle}",system="{system}",'
                                f'cost_center="{cost_center}"')
                      info_lines.append(f"backstage_catalog_service_info{{{labels}}} 1")
                  push_put(f"{PUSHGATEWAY}/metrics/job/catalog-service-info/instance/backstage",
                           "\n".join(info_lines) + "\n")
                  log.info("Pushed service info for %d components", len(components))
              resources:
                requests: { cpu: 50m, memory: 64Mi }
                limits:   { cpu: 200m, memory: 128Mi }
              volumeMounts:
                - name: deps
                  mountPath: /deps
          volumes:
            - name: deps
              emptyDir: {}
MANIFEST_END

log "Catalog exporter CronJob deployed (schedule: every 15 min)."
log "Triggering an immediate run now..."
kubectl create job "catalog-exporter-now-$(date +%s)" \
  --from=cronjob/catalog-exporter -n "${NAMESPACE}"
log "Job created. Watch with: kubectl logs -n ${NAMESPACE} -l job-name --follow"
