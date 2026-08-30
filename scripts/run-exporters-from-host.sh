#!/usr/bin/env bash
# Run the observability exporters from the host instead of from the cluster.
#
# Why this exists: on this machine the Kind cluster's egress to GitHub is
# unreliable — the same API call that answers in ~0.6s from the host returns
# ConnectionError and SSLError from inside a pod, so the dora-exporter and
# flaky-test-exporter CronJobs cannot fetch what they need and their dimensions
# (Developer Experience, Reliability, Quality) stay unscored. Running the exact
# same script from the host, pushing to the same Pushgateway, fills them.
#
# This is a workaround for a broken network, not a replacement for the CronJobs.
# When egress is fixed, the CronJobs resume and this script stops being needed.
#
# It does NOT hardcode configuration. Every environment variable is read from
# the live CronJob spec, so the script cannot drift from what the cluster
# actually runs; only in-cluster service DNS is rewritten to the host-reachable
# ingress, and each rewritten address is probed before anything runs.
#
# Usage:
#   ./scripts/run-exporters-from-host.sh                 # dora + flaky-test
#   ./scripts/run-exporters-from-host.sh flaky-test      # just one
#   ./scripts/run-exporters-from-host.sh --all           # every supported exporter
#   ./scripts/run-exporters-from-host.sh --list          # what can be run
#   ./scripts/run-exporters-from-host.sh --dry-run       # print config, run nothing
#   ./scripts/run-exporters-from-host.sh --loop 30       # repeat every 30 minutes
#
# Note Pushgateway is in-memory: if it restarts, pushed series are lost until
# something pushes again. Under memory pressure that happens, which is what
# --loop is for.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NS="${EXPORTER_NAMESPACE:-monitoring}"

# exporter name -> CronJob name : script path relative to the repo root.
# catalog-exporter is deliberately absent: its body is inline Python in the
# CronJob rather than a file in this repo, so there is nothing here to run.
SUPPORTED=(
  "dora:dora-exporter:local/observability/dora/dora-exporter.py"
  "flaky-test:flaky-test-exporter:observability/flaky-test-exporter/exporter.py"
  "tech-insights:tech-insights-exporter:observability/tech-insights-exporter/exporter.py"
)
DEFAULT=(dora flaky-test)

# In-cluster DNS -> host-reachable address. Probed before use.
rewrite_url() {
  local url="$1"
  url="${url//backstage.default.svc.cluster.local:3000/localhost:3000}"
  url="${url//prometheus-pushgateway.monitoring.svc.cluster.local:9091/pushgateway.idp.local}"
  url="${url//opencost.opencost.svc.cluster.local:9003/opencost.idp.local}"
  url="${url//prometheus-kube-prometheus-prometheus.monitoring.svc.cluster.local:9090/prometheus.idp.local}"
  printf '%s' "$url"
}

log()  { printf '\033[36m›\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

lookup() {  # name -> "cronjob:path", empty if unsupported
  local want="$1" entry
  for entry in "${SUPPORTED[@]}"; do
    [[ "${entry%%:*}" == "$want" ]] && { printf '%s' "${entry#*:}"; return 0; }
  done
  return 1
}

list_supported() {
  printf 'Exporters this script can run:\n'
  local entry name rest
  for entry in "${SUPPORTED[@]}"; do
    name="${entry%%:*}"; rest="${entry#*:}"
    printf '  %-14s CronJob %-24s %s\n' "$name" "${rest%%:*}" "${rest#*:}"
  done
  printf '\nDefault when no exporter is named: %s\n' "${DEFAULT[*]}"
  printf 'catalog-exporter is not listed: it is inline Python in its CronJob, not a file here.\n'
}

# Turn a CronJob's env into `export` lines, resolving secret and configMap refs
# and rewriting in-cluster URLs. Secrets are never printed.
env_for() {
  local cronjob="$1"
  kubectl get cronjob "$cronjob" -n "$NS" -o json 2>/dev/null |
    python3 -c '
import json, sys
try:
    spec = json.load(sys.stdin)["spec"]["jobTemplate"]["spec"]["template"]["spec"]
except Exception:
    sys.exit(1)
TAB = chr(9)
for e in spec["containers"][0].get("env", []):
    name = e["name"]
    if "value" in e:
        print(TAB.join(["value", name, e["value"]]))
        continue
    vf = e.get("valueFrom", {})
    if "secretKeyRef" in vf:
        r = vf["secretKeyRef"]
        print(TAB.join(["secret", name, r["name"], r["key"]]))
    elif "configMapKeyRef" in vf:
        r = vf["configMapKeyRef"]
        print(TAB.join(["configmap", name, r["name"], r["key"]]))
'
}

probe() {  # url label -> warn (not fail) so one dead optional source is not fatal
  local url="$1" label="$2" code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$url" 2>/dev/null || true)"
  case "$code" in
    2*|3*|4*) log "  reachable  $label -> $url (HTTP $code)"; return 0 ;;
    *)        warn "  UNREACHABLE $label -> $url"; return 1 ;;
  esac
}

# The exporters run in the cluster with their dependencies baked in (a /deps
# PYTHONPATH or a pip install in the container command). On the host they are
# whatever this machine happens to have, so check before running rather than
# failing three seconds in with a ModuleNotFoundError.
check_deps() {
  local script="$1" name="$2" missing=()
  local mods
  mods="$(grep -hoE '^(import|from) [a-z_][a-z0-9_]*' "$script" \
          | awk '{print $2}' | sort -u)"
  local m
  for m in $mods; do
    case "$m" in
      requests|prometheus_client|boto3|yaml|dateutil)
        python3 -c "import $m" 2>/dev/null || missing+=("$m") ;;
    esac
  done
  if (( ${#missing[@]} )); then
    die "$name needs Python package(s) this host lacks: ${missing[*]}
    install with: pip3 install ${missing[*]}"
  fi
}

run_one() {
  local name="$1" pair cronjob rel script
  pair="$(lookup "$name")" || die "unknown exporter '$name' (try --list)"
  cronjob="${pair%%:*}"; rel="${pair#*:}"
  script="$ROOT_DIR/$rel"
  [[ -f "$script" ]] || die "missing exporter script: $rel"

  kubectl get cronjob "$cronjob" -n "$NS" >/dev/null 2>&1 \
    || die "CronJob $cronjob not found in namespace $NS — is the cluster up?"

  check_deps "$script" "$name"

  log "$name — reading configuration from CronJob $cronjob"

  local -a envs=()
  local kind var a b val rewritten unreachable=0
  while IFS=$'\t' read -r kind var a b; do
    [[ -z "${kind:-}" ]] && continue
    case "$kind" in
      value)
        rewritten="$(rewrite_url "$a")"
        if [[ "$rewritten" != "$a" ]]; then
          probe "$rewritten" "$var" || unreachable=1
        fi
        val="$rewritten"
        ;;
      secret)
        val="$(kubectl get secret "$a" -n "$NS" -o jsonpath="{.data.$b}" 2>/dev/null | base64 -d 2>/dev/null || true)"
        [[ -z "$val" ]] && die "could not read secret $a/$b — needed for $var"
        log "  resolved   $var from secret $a/$b (${#val} chars)"
        ;;
      configmap)
        val="$(kubectl get configmap "$a" -n "$NS" -o jsonpath="{.data.$b}" 2>/dev/null || true)"
        ;;
    esac
    envs+=("$var=$val")
  done < <(env_for "$cronjob")

  [[ ${#envs[@]} -eq 0 ]] && die "no environment read from CronJob $cronjob"
  (( unreachable )) && warn "  one or more addresses did not respond; running anyway"

  if (( DRY_RUN )); then
    log "  would run: python3 $rel"
    printf '    %s\n' "${envs[@]%%=*}" | sed 's/^/    env: /'
    return 0
  fi

  log "  running python3 $rel"
  local started elapsed
  started=$SECONDS
  if env "${envs[@]}" python3 "$script"; then
    elapsed=$(( SECONDS - started ))
    log "  $name finished in ${elapsed}s"
  else
    elapsed=$(( SECONDS - started ))
    warn "  $name FAILED after ${elapsed}s"
    return 1
  fi
}

DRY_RUN=0
LOOP_MINUTES=0
declare -a WANTED=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --list)    list_supported; exit 0 ;;
    --all)     WANTED=(); for e in "${SUPPORTED[@]}"; do WANTED+=("${e%%:*}"); done; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --loop)    LOOP_MINUTES="${2:-30}"; shift 2 ;;
    -h|--help) sed -n '2,32p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)        die "unknown flag: $1 (try --help)" ;;
    *)         WANTED+=("$1"); shift ;;
  esac
done
[[ ${#WANTED[@]} -eq 0 ]] && WANTED=("${DEFAULT[@]}")

command -v kubectl >/dev/null || die "kubectl not found"

failed=0
while :; do
  log "running from the host: ${WANTED[*]}"
  for name in "${WANTED[@]}"; do
    run_one "$name" || failed=1
  done

  if (( LOOP_MINUTES > 0 )); then
    log "sleeping ${LOOP_MINUTES}m — Pushgateway is in-memory, so a restart needs a re-push"
    sleep $(( LOOP_MINUTES * 60 ))
  else
    break
  fi
done

(( failed )) && die "at least one exporter failed"
log "done"
