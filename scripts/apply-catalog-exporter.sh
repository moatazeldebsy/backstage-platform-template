#!/usr/bin/env bash
# apply-catalog-exporter.sh — Deploy the Backstage catalog exporter CronJob.
# Queries the Backstage catalog API every 15 min and pushes two metric families
# to the Prometheus Pushgateway:
#   - backstage_catalog_entities_total   (count by kind)
#   - backstage_catalog_service_info     (info metric per Component, with labels)
#
# Prerequisites:
#   - Kind cluster running with 'monitoring' namespace
#   - Backstage reachable at backstage.default.svc.cluster.local:3000 (in-cluster)
#   - Prometheus Pushgateway running in the monitoring namespace
#
# Usage:
#   ./scripts/apply-catalog-exporter.sh
#   # Force an immediate run after deploying:
#   kubectl create job catalog-exporter-now --from=cronjob/catalog-exporter -n monitoring
set -euo pipefail

NAMESPACE="monitoring"
# Backstage lives in a different place per environment, and this script is called by
# BOTH bootstraps. On Kind it is a Docker Compose container fronted by a
# selector-less Service in the default namespace on :3000; on EKS it is a real
# Deployment in the backstage namespace on :80. Hardcoding the local address left
# catalog-exporter in CrashLoopBackOff on AWS with
#   Failed to resolve 'backstage.default.svc.cluster.local'
# Detect the real Service rather than guessing, so neither environment needs a flag.
# Observed 2026-08-13.
if kubectl get svc backstage -n backstage >/dev/null 2>&1; then
  BACKSTAGE_URL="${BACKSTAGE_URL:-http://backstage.backstage.svc.cluster.local:80}"
else
  BACKSTAGE_URL="${BACKSTAGE_URL:-http://backstage.default.svc.cluster.local:3000}"
fi
PUSHGATEWAY_URL="http://prometheus-pushgateway.monitoring.svc.cluster.local:9091"
# Same split as BACKSTAGE_URL above. app-config.local.yaml pins the static
# externalAccess token to the literal "local-catalog-exporter-token", but on AWS
# bootstrap.sh generates a random BACKSTAGE_CATALOG_TOKEN into Secrets Manager and
# syncs it to backstage-secrets. Using the local literal there would have produced a
# 401 from every export the moment the URL was fixed. Prefer the real cluster secret
# and fall back to the local literal.
CATALOG_TOKEN="${CATALOG_TOKEN:-$(kubectl get secret backstage-secrets -n backstage \
  -o jsonpath='{.data.BACKSTAGE_CATALOG_TOKEN}' 2>/dev/null | base64 -d 2>/dev/null || true)}"
CATALOG_TOKEN="${CATALOG_TOKEN:-local-catalog-exporter-token}"

log()  { echo "[$(date +%T)] INFO  $*"; }
warn() { echo "[$(date +%T)] WARN  $*"; }

if ! kubectl get namespace "${NAMESPACE}" &>/dev/null; then
  warn "Namespace '${NAMESPACE}' not found. Run bootstrap-local.sh first."
  exit 1
fi

log "Deploying catalog exporter to namespace ${NAMESPACE}..."

sed -e "s|BACKSTAGE_URL_PLACEHOLDER|${BACKSTAGE_URL}|g" \
    -e "s|CATALOG_TOKEN_PLACEHOLDER|${CATALOG_TOKEN}|g" <<'MANIFEST_END' | kubectl apply -f -
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
                # Interpolated from the variables resolved at the top of this
                # script, NOT hardcoded. These two lines previously repeated the
                # local address and the local static token verbatim, so the
                # environment detection above had no effect on what actually got
                # deployed and the CronJob crashlooped on AWS with
                #   Failed to resolve 'backstage.default.svc.cluster.local'
                - name: BACKSTAGE_URL
                  value: BACKSTAGE_URL_PLACEHOLDER
                - name: CATALOG_TOKEN
                  value: CATALOG_TOKEN_PLACEHOLDER
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
