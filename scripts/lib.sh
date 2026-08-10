#!/usr/bin/env bash
# lib.sh — Shared helpers for IDP bootstrap scripts.
# Source this file; do not execute it directly.
[[ -n "${_IDP_LIB_LOADED:-}" ]] && return 0
_IDP_LIB_LOADED=1

# ── Shared helm --wait timeouts ──────────────────────────────────────────────
# Use these instead of hand-rolled --timeout values so a slow Docker pull on a
# cold cluster doesn't silently trip the helm default (5m).
HELM_WAIT_SHORT="${HELM_WAIT_SHORT:-5m}"
HELM_WAIT_MED="${HELM_WAIT_MED:-10m}"
HELM_WAIT_LONG="${HELM_WAIT_LONG:-15m}"

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
RESET='\033[0m'

log()   { echo -e "[$(date +%T)] $*"; }
warn()  { echo -e "[$(date +%T)] ${YELLOW}WARN${RESET}  $*"; }
err()   { echo -e "[$(date +%T)] ${RED}ERROR${RESET} $*" >&2; exit 1; }
step()  { echo -e "\n${BOLD}▶ $*${RESET}"; }
check() { echo -e "[$(date +%T)] ${GREEN}✓${RESET} $*"; }

# ── Step timing ──────────────────────────────────────────────────────────────
# Per-step wall-clock timing so "the bootstrap is slow" can be answered with
# data instead of a guess. Parallel arrays rather than an associative array:
# lib.sh targets Bash 3.2 (macOS default), which has neither `declare -A` nor
# `${EPOCHREALTIME}`.
#
# Usage:
#   timer_start "KAgent"
#   ...work...
#   timer_end   "KAgent"
# and once, near the top of a script:
#   timer_enable_summary        # installs the EXIT trap
#
# Set IDP_TIMING=0 to silence both the per-step lines and the summary.
_TIMER_LABELS=()
_TIMER_SECONDS=()
_TIMER_ACTIVE_LABEL=""
_TIMER_ACTIVE_START=""
_TIMER_RUN_START="$(date +%s)"

timer_start() {
  [[ "${IDP_TIMING:-1}" == "1" ]] || return 0
  _TIMER_ACTIVE_LABEL="$1"
  _TIMER_ACTIVE_START="$(date +%s)"
}

# Records elapsed time for $1 and prints it. Tolerates a missing/mismatched
# timer_start (e.g. a step that exited early) instead of emitting a bogus
# duration measured from some unrelated earlier step.
timer_end() {
  [[ "${IDP_TIMING:-1}" == "1" ]] || return 0
  local label="$1" elapsed
  if [[ -z "$_TIMER_ACTIVE_START" || "$_TIMER_ACTIVE_LABEL" != "$label" ]]; then
    _TIMER_ACTIVE_LABEL=""; _TIMER_ACTIVE_START=""
    return 0
  fi
  elapsed=$(( $(date +%s) - _TIMER_ACTIVE_START ))
  _TIMER_LABELS+=("$label")
  _TIMER_SECONDS+=("$elapsed")
  _TIMER_ACTIVE_LABEL=""; _TIMER_ACTIVE_START=""
  echo -e "[$(date +%T)] ${CYAN}⏱${RESET}  ${label}: $(_fmt_duration "$elapsed")"
}

_fmt_duration() {
  local s="$1"
  if (( s < 60 )); then printf '%ds' "$s"; else printf '%dm%02ds' $(( s / 60 )) $(( s % 60 )); fi
}

# Slowest-first table plus total wall time. Safe to call with no recorded
# steps (prints nothing), so the EXIT trap is harmless on an early failure.
timer_summary() {
  [[ "${IDP_TIMING:-1}" == "1" ]] || return 0
  (( ${#_TIMER_LABELS[@]} > 0 )) || return 0
  local i total
  total=$(( $(date +%s) - _TIMER_RUN_START ))
  echo ""
  echo -e "${BOLD}▶ Step timings (slowest first)${RESET}"
  for (( i = 0; i < ${#_TIMER_LABELS[@]}; i++ )); do
    printf '%s\t%s\n' "${_TIMER_SECONDS[$i]}" "${_TIMER_LABELS[$i]}"
  done | sort -rn | while IFS=$'\t' read -r secs label; do
    printf '  %-46s %s\n' "$label" "$(_fmt_duration "$secs")"
  done
  printf '  %-46s %s\n' "TOTAL (wall clock)" "$(_fmt_duration "$total")"
  echo ""
}

# Print the summary on exit, including on failure — the timings for the steps
# that DID complete are exactly what you want when a run dies partway through.
# Chains onto any EXIT trap the caller already installed.
timer_enable_summary() {
  [[ "${IDP_TIMING:-1}" == "1" ]] || return 0
  local existing
  existing="$(trap -p EXIT | sed -n "s/^trap -- '\(.*\)' EXIT$/\1/p")"
  if [[ -n "$existing" ]]; then
    # shellcheck disable=SC2064
    trap "${existing}; timer_summary" EXIT
  else
    trap 'timer_summary' EXIT
  fi
}

# GNU vs BSD sed differ in how `-i` takes its backup suffix. Detect once per
# shell rather than per call: `sed --version 2>&1 | grep -q GNU` is two forked
# processes, and _sed paid that on *every* invocation — three processes per file
# in the personalisation pass, which is the bulk of its cost.
_SED_FLAVOR="${_SED_FLAVOR:-}"
_sed_flavor_init() {
  [[ -n "${_SED_FLAVOR:-}" ]] && return 0
  if sed --version 2>&1 | grep -q GNU; then
    _SED_FLAVOR=gnu
  else
    _SED_FLAVOR=bsd
  fi
}

_sed() {
  _sed_flavor_init
  if [[ "$_SED_FLAVOR" == gnu ]]; then
    sed -i "$@"
  else
    sed -i '' "$@"
  fi
}

_upsert_env() {
  local file="$1" key="$2" val="$3"
  if grep -q "^${key}=" "$file" 2>/dev/null; then
    _sed "s|^${key}=.*|${key}=${val}|" "$file"
  else
    echo "${key}=${val}" >> "$file"
  fi
}

# Source .idp-config.env (the single-source-of-truth file written by setup.sh)
# into the current shell. Exports every assignment so child processes see them.
# No-op when the file is absent — callers can still rely on local/.env fallback.
load_idp_config() {
  local f="${ROOT_DIR:-$(pwd)}/.idp-config.env"
  if [[ -f "$f" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$f"
    set +a
  fi
}

# Parse scripts/placeholders.conf into parallel arrays:
#   MANIFEST_NAMES, MANIFEST_PLACEHOLDERS, MANIFEST_DEFAULTS,
#   MANIFEST_LITERALS, MANIFEST_PROMPTS, MANIFEST_REQUIREDS
# (Bash 3.2-compatible — macOS default. No associative arrays.)
#
# DEFAULTS = prompt default (display only)
# LITERALS = hardcoded value to also sed-replace (blank = none)
load_placeholder_manifest() {
  local manifest="${ROOT_DIR:-$(pwd)}/scripts/placeholders.conf"
  [[ -f "$manifest" ]] || err "Manifest not found: $manifest"
  MANIFEST_NAMES=(); MANIFEST_PLACEHOLDERS=(); MANIFEST_DEFAULTS=()
  MANIFEST_LITERALS=(); MANIFEST_PROMPTS=(); MANIFEST_REQUIREDS=()
  # Bash parameter expansion for whitespace trimming — avoids forking `echo | sed`
  # per field per row (48 subprocesses on macOS = ~9s; this is ~instant).
  _trim() {
    local s="$1"
    s="${s#"${s%%[![:space:]]*}"}"
    s="${s%"${s##*[![:space:]]}"}"
    printf '%s' "$s"
  }
  local name placeholder default literal prompt required
  while IFS='|' read -r name placeholder default literal prompt required; do
    name="$(_trim "$name")"
    [[ -z "$name" || "$name" =~ ^# ]] && continue
    placeholder="$(_trim "$placeholder")"
    default="$(_trim "$default")"
    literal="$(_trim "$literal")"
    prompt="$(_trim "$prompt")"
    required="$(_trim "$required")"
    MANIFEST_NAMES+=("$name")
    MANIFEST_PLACEHOLDERS+=("$placeholder")
    MANIFEST_DEFAULTS+=("$default")
    MANIFEST_LITERALS+=("$literal")
    MANIFEST_PROMPTS+=("$prompt")
    MANIFEST_REQUIREDS+=("$required")
  done < "$manifest"
  unset -f _trim
}

# Wait for a namespace to leave the Terminating phase before re-applying it.
# A previous failed run can leave namespaces stuck Terminating while finalisers
# clear; subsequent creates fail with "namespace is being terminated".
#   $1 = namespace name
#   $2 = optional max wait seconds (default 120)
wait_namespace_clear() {
  local ns="$1" max="${2:-120}" phase elapsed=0
  while (( elapsed < max )); do
    phase=$(kubectl get ns "$ns" -o jsonpath='{.status.phase}' 2>/dev/null || echo "")
    [[ "$phase" != "Terminating" ]] && return 0
    sleep 2
    elapsed=$((elapsed + 2))
  done
  warn "Namespace $ns still Terminating after ${max}s — continuing anyway."
}

# Wait for the Kubernetes API to respond. Useful right after a control-plane
# restart (e.g. k3s on Rancher Desktop) where kubectl racy-rejects requests.
#   $1 = optional max wait seconds (default 60)
wait_kubectl_ready() {
  local max="${1:-60}" elapsed=0
  while (( elapsed < max )); do
    kubectl get --raw='/readyz' >/dev/null 2>&1 && return 0
    sleep 2
    elapsed=$((elapsed + 2))
  done
  warn "kubectl API not ready after ${max}s — continuing, downstream steps may fail."
}

# Poll a predicate until it succeeds, or give up.
#
# The bootstrap scripts had eight near-identical hand-rolled `while … sleep n`
# loops between them, each with its own off-by-one and its own idea of whether
# timing out is fatal. This is that shape, once.
#
#   poll_until <desc> <max-seconds> <interval-seconds> <command...>
#
# Returns 0 as soon as the command exits 0; returns 1 on timeout (the caller
# decides whether that is fatal — this never exits the script itself). Progress
# is logged at most once every ~30s so a long wait shows life without flooding.
poll_until() {
  local desc="$1" max="$2" interval="$3"; shift 3
  local elapsed=0 next_note=30
  while (( elapsed < max )); do
    if "$@"; then
      (( elapsed > 0 )) && info "  ${desc}: ready after ${elapsed}s."
      return 0
    fi
    sleep "$interval"
    elapsed=$((elapsed + interval))
    if (( elapsed >= next_note )); then
      info "  ${desc}: still waiting (${elapsed}s/${max}s)..."
      next_note=$((elapsed + 30))
    fi
  done
  return 1
}

# Map a helm repo short-name to its chart index URL. Single source of truth so
# each bootstrap script doesn't hand-maintain its own copy (they drifted before:
# some scripts hardcoded `helm repo update` with no repo arg, refreshing every
# repo the user has ever added, not just the ones this run needs).
_helm_repo_url() {
  case "$1" in
    ingress-nginx)        echo "https://kubernetes.github.io/ingress-nginx" ;;
    prometheus-community) echo "https://prometheus-community.github.io/helm-charts" ;;
    opencost)             echo "https://opencost.github.io/opencost-helm-chart" ;;
    argo)                 echo "https://argoproj.github.io/argo-helm" ;;
    grafana)              echo "https://grafana.github.io/helm-charts" ;;
    gatekeeper)           echo "https://open-policy-agent.github.io/gatekeeper/charts" ;;
    kyverno)              echo "https://kyverno.github.io/kyverno/" ;;
    external-secrets)     echo "https://charts.external-secrets.io" ;;
    bitnami)              echo "https://charts.bitnami.com/bitnami" ;;
    datadog)              echo "https://helm.datadoghq.com" ;;
    vmware-tanzu)         echo "https://vmware-tanzu.github.io/helm-charts" ;;
    *)                    echo "" ;;
  esac
}

# Add (idempotent, local-only, no network) every repo this script needs, then
# run exactly one `helm repo update` scoped to just those repos — replaces the
# old pattern of calling `helm repo add`/`helm repo update` before every single
# chart install, which re-fetched the same repo's index multiple times per run
# and, in a few scripts, called a bare `helm repo update` that refreshes every
# repo ever added on the machine, not just the ones this run touches.
#   $@ = repo short-names (must be known to _helm_repo_url)
ensure_helm_repos() {
  local repo url
  for repo in "$@"; do
    url=$(_helm_repo_url "$repo")
    if [[ -z "$url" ]]; then
      warn "ensure_helm_repos: unknown repo '${repo}' — skipping"
      continue
    fi
    helm repo add "$repo" "$url" 2>/dev/null || true
  done
  helm repo update "$@"
}

# Load every `terraform output` value for the current stack once, cached in
# _TF_OUTPUTS_JSON for the life of the shell process. Replaces the pattern of
# calling `terraform output -raw <name>` once per value, which re-parses the
# whole state file and re-runs provider handshakes on every single call.
#   $1 = terraform working dir (default: $TF_DIR, else "terraform")
tf_outputs_load() {
  local tf_dir="${1:-${TF_DIR:-terraform}}"
  _TF_OUTPUTS_JSON=$(cd "$tf_dir" && terraform output -json 2>/dev/null) || true
  # Must not end on a short-circuit: `[[ -z X ]] && Y` returns 1 whenever X is
  # non-empty, which is the *success* case here. As the function's last
  # statement that made tf_outputs_load return 1 to its caller, and under
  # `set -euo pipefail` a bare `tf_outputs_load "$TF_DIR"` then aborted the
  # whole script — bootstrap.sh died right after `terraform apply` precisely
  # when terraform outputs were readable. Explicit `return 0` so the exit
  # status can't drift again.
  [[ -n "${_TF_OUTPUTS_JSON:-}" ]] || _TF_OUTPUTS_JSON='{}'
  return 0
}

# Read a single output value from the JSON loaded by tf_outputs_load. Returns
# empty string (never errors) when the key is absent, matching the existing
# `terraform output -raw X 2>/dev/null || echo ""` fallback callers already rely on.
tf_output() {
  local name="$1" json="${_TF_OUTPUTS_JSON:-}"
  # Deliberately not `<<<"${_TF_OUTPUTS_JSON:-{}}"`: bash ends the parameter
  # expansion at the first `}` of the `{}` default, so that form expands to the
  # JSON with a stray `}` appended. jq then printed the right value but also
  # "parse error: Unmatched '}'" on stderr and exited non-zero on every single
  # call — noise on success, and a non-zero status from what looks like a pure
  # accessor.
  [[ -n "$json" ]] || json='{}'
  jq -r --arg n "$name" '.[$n].value // empty' <<<"$json"
}

# Same as tf_output, but aborts the script (via err/exit 1) when the value is
# missing — use for outputs the original `terraform output -raw <name>` call
# (with no `2>/dev/null || echo ""` fallback) would have relied on `set -e` to
# fail on. tf_output alone never errors, so callers that need fail-fast
# behavior must use this instead of silently continuing with an empty value.
tf_output_required() {
  local name="$1" val
  val=$(tf_output "$name")
  [[ -n "$val" ]] || err "terraform output '${name}' is empty or missing — check terraform apply/workspace succeeded"
  printf '%s' "$val"
}

# sha256 of a file, portable across macOS (no sha256sum by default, has shasum)
# and Linux (has sha256sum, may lack shasum).
_sha256() {
  if command -v sha256sum &>/dev/null; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# Skip-if-unchanged check for a Helm release, so re-running a bootstrap script
# against an already-healthy cluster doesn't pay for a full `helm upgrade
# --install --wait` (which can look "stuck" for minutes with no output even
# when it ultimately succeeds). Only ever skips when BOTH the chart
# version+values fingerprint from the last successful install matches the
# caller's current desired fingerprint AND Helm itself reports the release as
# "deployed" — an edited values file, a version bump, or a release Helm
# considers unhealthy always falls through to a real install. This mirrors
# the plan's "skip rebuilding verifiably unchanged artifacts" rule, applied to
# Helm releases instead of Docker images.
#   $1 = release name   $2 = namespace   $3 = fingerprint file path
#   $4 = desired fingerprint (caller computes, e.g. "<version>:<sha256 of values file>")
#   $5.. = optional extra flags forwarded to `helm status` (e.g. --kube-context
#          standby), so the health check runs against the cluster the release
#          actually lives on rather than whatever context happens to be current.
helm_release_unchanged() {
  local release="$1" ns="$2" fp_file="$3" desired="$4"; shift 4
  [[ -f "$fp_file" ]] || return 1
  [[ "$(cat "$fp_file" 2>/dev/null)" == "$desired" ]] || return 1
  # Plain-text `helm status` output (not -o json) so this has no jq dependency —
  # jq isn't a required tool for local (Kind) bootstrap runs.
  helm status "$release" -n "$ns" "$@" 2>/dev/null | grep -q '^STATUS: deployed'
}

# Record the fingerprint used by helm_release_unchanged after a successful
# install — call only once the install/upgrade actually succeeded.
#   $1 = fingerprint file path   $2 = fingerprint value
helm_record_fingerprint() {
  mkdir -p "$(dirname "$1")"
  printf '%s' "$2" > "$1"
}

# Drop-in replacement for `helm upgrade --install <release> <chart> [flags...]`
# that skips the call entirely when nothing that affects the result has changed
# and Helm still reports the release deployed.
#
#   helm_upgrade_cached <release> <namespace> <chart> [helm flags...]
#
# The fingerprint is derived from the full argument list — chart reference,
# --version, every --set — plus the *contents* of every file passed to --values
# or -f. So a values edit, a chart bump, or a changed --set all fall through to
# a real install; only a byte-identical invocation against a healthy release is
# skipped. `helm upgrade --install` is itself idempotent, but not free: each one
# re-renders and diffs the chart and then blocks on `--wait` polling, which on a
# cold cluster is minutes per release.
#
# Set IDP_FORCE=1 to bypass every skip (equivalent to the callers' --force-*
# flags, and useful for a one-off "reinstall everything" run).
helm_upgrade_cached() {
  local release="$1" ns="$2"; shift 2
  local a prev="" desired ctx=""
  # Pick the target cluster out of the flags. Two reasons this matters in
  # multi-cluster scripts (bootstrap-multiregion.sh installs the same release
  # name+namespace on both the hub and standby clusters):
  #   1. the fingerprint file must not be shared between clusters, or each run
  #      would overwrite the other's and neither would ever cache; and
  #   2. the `helm status` health check must run against the right cluster, or
  #      a healthy hub release could green-light skipping the standby install.
  for a in "$@"; do
    [[ "$prev" == "--kube-context" ]] && ctx="$a"
    prev="$a"
  done
  prev=""

  local fp_file="${IDP_CACHE_DIR:-${ROOT_DIR:-$(pwd)}/.idp-cache}/helm-${ctx:+${ctx}-}${ns}-${release}.fingerprint"
  desired=$(
    {
      printf '%s\n%s\n' "$release" "$ns"
      for a in "$@"; do
        if [[ "$prev" == "--values" || "$prev" == "-f" ]] && [[ -f "$a" ]]; then
          # Hash the file's CONTENT and deliberately NOT its path: several call
          # sites render values through `mktemp` (prometheus, velero), so the
          # path is different on every run and including it would defeat the
          # cache entirely. Content is what actually affects the release.
          _sha256 "$a"
        else
          printf '%s\n' "$a"
        fi
        prev="$a"
      done
    } | _sha256_stdin
  )

  local status_args=()
  [[ -n "$ctx" ]] && status_args=(--kube-context "$ctx")

  if [[ "${IDP_FORCE:-0}" != "1" ]] && \
     helm_release_unchanged "$release" "$ns" "$fp_file" "$desired" ${status_args[@]+"${status_args[@]}"}; then
    log "  ${release}: chart and values unchanged, release healthy — skipping helm upgrade${ctx:+ (context: $ctx)}."
    return 0
  fi

  helm upgrade --install "$release" "$@" || return $?
  helm_record_fingerprint "$fp_file" "$desired"
}

# Content hash of a source directory, used to decide whether a Docker image
# needs rebuilding. Prefers `git ls-files -s` (already-computed blob SHAs — no
# re-hashing of file contents, and it honours .gitignore so node_modules/dist
# never enter the hash). Falls back to hashing file contents directly for an
# untracked directory (e.g. a service scaffolded but not yet committed).
#
# NOTE: the git path hashes *committed/staged* blob SHAs, so an uncommitted
# working-tree edit does not change the hash on its own. `git status
# --porcelain` for the directory is folded in to cover exactly that case.
#   $1 = directory path
#
# Extra git pathspecs may follow the directory, typically exclusions:
#
#   dir_content_hash services/hello-service ':!services/hello-service/helm-values-aws.yaml'
#
# Use that for files the build does not consume but the bootstrap itself
# rewrites — otherwise the script's own output feeds back into the fingerprint
# and every run looks changed. Exclusions apply to the git path only; the
# non-git `find` fallback ignores them, which is safe because that path is for
# directories git cannot see at all.
dir_content_hash() {
  local dir="$1"; shift
  local top listing=""
  local -a specs=("$dir" "$@")
  if top=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null); then
    listing=$(
      # Tracked files: index blob SHAs, no content re-hashing.
      git -C "$top" ls-files -s -- "${specs[@]}" 2>/dev/null
      # Modified, deleted, and untracked-but-not-ignored files: the blob SHAs
      # above are stale (or absent) for these, so mix in live content. -z plus
      # `read -d ''` keeps paths with spaces and renames intact.
      git -C "$top" ls-files -m -d -o --exclude-standard -z -- "${specs[@]}" 2>/dev/null \
        | while IFS= read -r -d '' rel; do
            printf '%s ' "$rel"
            [[ -f "$top/$rel" ]] && _sha256 "$top/$rel"
            printf '\n'
          done
    )
  fi
  if [[ -n "$listing" ]]; then
    printf '%s' "$listing" | _sha256_stdin
  else
    # Not a git work tree, or the whole directory is gitignored — hash contents
    # directly. Without this an ignored dir would hash to a constant and every
    # build would be skipped forever.
    find "$dir" -type f \
      ! -path '*/node_modules/*' ! -path '*/dist/*' ! -path '*/.git/*' \
      -print0 2>/dev/null | sort -z | xargs -0 shasum -a 256 2>/dev/null | _sha256_stdin
  fi
}

# sha256 of stdin (companion to _sha256, which takes a file path).
_sha256_stdin() {
  if command -v sha256sum &>/dev/null; then
    sha256sum | awk '{print $1}'
  else
    shasum -a 256 | awk '{print $1}'
  fi
}

# Skip-if-unchanged check for a Docker image build, the image-level counterpart
# to helm_release_unchanged. Skips only when BOTH the recorded fingerprint from
# the last successful build+push matches the caller's current source hash AND
# the tag still actually exists in the target registry — so a wiped local
# registry (the normal state after `bootstrap-local.sh --destroy`) or a deleted
# ECR tag always falls through to a real build instead of leaving the cluster
# pointing at an image that isn't there.
#   $1 = fingerprint file path
#   $2 = desired fingerprint (e.g. output of dir_content_hash)
#   $3 = command string that exits 0 iff the tag exists in the registry
image_unchanged() {
  local fp_file="$1" desired="$2" verify_cmd="$3"
  [[ -f "$fp_file" ]] || return 1
  [[ "$(cat "$fp_file" 2>/dev/null)" == "$desired" ]] || return 1
  eval "$verify_cmd" &>/dev/null
}

# Build a linux/amd64 image and push it, reusing a registry-side layer cache.
#
# On an Apple-Silicon host `--platform linux/amd64` runs the whole build under
# QEMU emulation, which for the npm/yarn-install-heavy images here is by far the
# slowest single operation in an AWS bootstrap. The emulation can't be avoided
# while the EKS nodes are amd64, but re-emulating layers that haven't changed
# can: `--cache-from/--cache-to type=registry` keeps the layer cache in ECR
# next to the image, so a rebuild only re-runs the stages that actually changed
# (and a build on a different machine, or in CI, hits the same cache).
#
#   docker_build_push_amd64 <context> <cache-repo> [-t tag]... [-f file] [--build-arg ...]
#
# Always pushes. Falls back to plain `docker build` + `docker push` per -t tag
# when buildx isn't available, so this stays safe on an older Docker.
docker_build_push_amd64() {
  local ctx="$1" cache_ref="$2"; shift 2
  local a prev="" tags=()
  for a in "$@"; do
    [[ "$prev" == "-t" ]] && tags+=("$a")
    prev="$a"
  done

  if docker buildx version &>/dev/null; then
    docker buildx build \
      --platform linux/amd64 --provenance=false \
      --cache-from "type=registry,ref=${cache_ref}:buildcache" \
      --cache-to "type=registry,ref=${cache_ref}:buildcache,mode=max,image-manifest=true" \
      "$@" --push "$ctx"
  else
    docker build --platform linux/amd64 --provenance=false "$@" "$ctx"
    local t
    for t in "${tags[@]}"; do docker push "$t"; done
  fi
}

# Wait for a background job (started with `cmd >"$log" 2>&1 & pid=$!`), cat
# its captured log, and return the job's own exit code. `set -euo pipefail`
# does NOT propagate a backgrounded job's failure automatically, so every
# parallel section must wait on each PID individually and check its exit
# code — this is that check, done consistently everywhere instead of
# hand-rolled per call site.
#
# Deliberately does NOT decide warn-vs-abort itself and must NOT be used to
# short-circuit (e.g. `_bg_join .. || err ..`) inside a loop over several
# jobs — that would exit before the remaining jobs are waited on, leaving
# them running detached after the script exits. Callers that need "any
# failure aborts the script" (matching a step that was fail-fast before
# parallelizing) must call this for every job first, aggregate the results,
# and only then call err() once, after every job has actually finished. See
# the Steps 5b/5b-pre/5c/5d block in bootstrap-local.sh for the pattern.
#   $1 = pid (empty is a no-op that returns 0 — lets callers unconditionally
#        call this even for a step that was skipped and never backgrounded)
#   $2 = log file path
_bg_join() {
  local pid="$1" log="$2" rc=0
  [[ -z "$pid" ]] && return 0
  wait "$pid" || rc=$?
  cat "$log"
  rm -f "$log"
  return "$rc"
}

# Kyverno's admission-controller Deployment can report Available before its
# self-managed webhook TLS cert has finished propagating — a request landing
# in that window fails with "remote error: tls: internal error" and a 10s
# webhook timeout even though the pod itself is healthy (observed: ArgoCD's
# routine reconciliation of kubernetes/namespaces/namespaces.yaml hit this
# right after a Kyverno reinstall). `kubectl wait --for=condition=Available`
# only checks the Deployment, not the webhook path itself, so probe the
# webhook directly with a harmless dry-run apply (still goes through
# admission, creates nothing) before declaring Kyverno ready.
#   $1 = optional max wait seconds (default 30)
#   $2 = optional kubectl context name (for multi-cluster scripts)
wait_kyverno_webhook_ready() {
  local max="${1:-30}" ctx="${2:-}" elapsed=0
  local -a ctx_args=()
  [[ -n "$ctx" ]] && ctx_args=(--context "$ctx")
  while (( elapsed < max )); do
    kubectl create namespace kyverno-webhook-probe --dry-run=server -o yaml ${ctx_args[@]+"${ctx_args[@]}"} &>/dev/null && return 0
    sleep 2
    elapsed=$((elapsed + 2))
  done
  warn "Kyverno webhook not responding after ${max}s — later applies may hit transient TLS errors until it settles."
}

# Append entries from a hosts-style file to /etc/hosts.
#   $1 = path to source file (lines like "127.0.0.1 hostname.idp.local")
#   $2 = optional ERE filter — only lines matching this regex are processed
# Idempotent: skips entries already present. Flushes the macOS DNS cache when
# anything was added. Returns 0 even if no changes were made.
append_hosts_file() {
  local file="$1" filter="${2:-}"
  [[ -f "$file" ]] || { warn "append_hosts_file: $file not found"; return 0; }
  local added=false line hostname
  while IFS= read -r line; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ -n "$filter" ]] && ! echo "$line" | grep -qE "$filter" && continue
    hostname=$(awk '{print $2}' <<< "$line")
    [[ -z "$hostname" ]] && continue
    if ! grep -qF "$hostname" /etc/hosts 2>/dev/null; then
      if sudo sh -c "echo '$line' >> /etc/hosts"; then
        log "  Added to /etc/hosts: $hostname"
        added=true
      else
        warn "  Could not add '$hostname' to /etc/hosts. Add manually:"
        warn "  echo '$line' | sudo tee -a /etc/hosts"
      fi
    fi
  done < "$file"

  if $added; then
    if [[ "$(uname)" == "Darwin" ]]; then
      sudo dscacheutil -flushcache 2>/dev/null || true
      sudo killall -HUP mDNSResponder 2>/dev/null || true
      log "  macOS DNS cache flushed."
    elif command -v resolvectl &>/dev/null; then
      sudo resolvectl flush-caches 2>/dev/null || true
    fi
  else
    log "  /etc/hosts already up to date — no changes needed."
  fi
}

# Discover and remove user-scaffolded services from ArgoCD, Helm, and the git repo.
# Built-in platform services are never touched. Safe to call while the cluster is up;
# all cluster operations are best-effort (|| true) so failure never aborts a destroy.
#   $1 = env_suffix: "local" (Kind/Rancher) | "dev" (AWS)
_cleanup_scaffolded_services() {
  local env_suffix="${1:-local}"
  local PLATFORM_BUILTINS=("hello-service" "idp-mcp-server" "qa-mcp-server" "contract-mcp-server" "github-mcp-server" "argocd-mcp-server" "cost-mcp-server" "agent-event-router" "approval-service" "incident-mcp-server" "security-mcp-server")
  local svc builtin skip

  local SCAFFOLDED=()
  if [[ -d "${ROOT_DIR}/services" ]]; then
    while IFS= read -r svc; do
      skip=false
      for builtin in "${PLATFORM_BUILTINS[@]}"; do
        [[ "$svc" == "$builtin" ]] && { skip=true; break; }
      done
      $skip || SCAFFOLDED+=("$svc")
    done < <(find "${ROOT_DIR}/services" -maxdepth 1 -mindepth 1 -type d -exec basename {} \;)
  fi

  if [[ ${#SCAFFOLDED[@]} -eq 0 ]]; then
    log "  No scaffolded services found — nothing to clean up."
    return 0
  fi

  log "  Found ${#SCAFFOLDED[@]} scaffolded service(s): ${SCAFFOLDED[*]}"

  # Delete ArgoCD Applications (cascade-deletes all managed K8s resources).
  for svc in ${SCAFFOLDED[@]+"${SCAFFOLDED[@]}"}; do
    local app_name="${svc}-${env_suffix}"
    log "  Deleting ArgoCD Application: ${app_name}"
    if command -v argocd &>/dev/null; then
      argocd app delete "${app_name}" --cascade --yes --grpc-web 2>/dev/null || true
    fi
    kubectl delete application "${app_name}" -n argocd --ignore-not-found 2>/dev/null || true
  done

  # Uninstall Helm releases (belt-and-suspenders for services deployed via idp:deploy-local).
  for svc in ${SCAFFOLDED[@]+"${SCAFFOLDED[@]}"}; do
    log "  Uninstalling Helm release: ${svc}"
    helm uninstall "${svc}" -n services-dev 2>/dev/null || true
    helm uninstall "${svc}" -n services    2>/dev/null || true
  done

  # Remove services/ directories and commit so new clusters don't re-discover them.
  local removed=()
  for svc in ${SCAFFOLDED[@]+"${SCAFFOLDED[@]}"}; do
    if [[ -d "${ROOT_DIR}/services/${svc}" ]]; then
      rm -rf "${ROOT_DIR}/services/${svc}"
      removed+=("$svc")
      log "  Removed: services/${svc}/"
    fi
  done

  # Remove IDP catalog GitHub topics so the org provider doesn't re-discover
  # these repos on the next fresh cluster install.
  if [[ -n "${GITHUB_TOKEN:-}" ]] && command -v gh &>/dev/null; then
    local org="${GITHUB_ORG:-moatazeldebsy}"
    for svc in ${SCAFFOLDED[@]+"${SCAFFOLDED[@]}"}; do
      gh repo edit "${org}/${svc}" \
        --remove-topic idp \
        --remove-topic idp-service \
        --remove-topic idp-module 2>/dev/null \
        || true
      log "  Removed IDP topics from GitHub repo: ${org}/${svc}"
    done
  fi

  # Clean up committed catalog entries for ML experiments and team-namespace groups
  # that are not covered by the services/ scan above.
  local catalog_changed=false

  if compgen -G "${ROOT_DIR}/backstage/catalog/ml-experiments/*/catalog-info.yaml" > /dev/null 2>&1; then
    find "${ROOT_DIR}/backstage/catalog/ml-experiments" -mindepth 1 -maxdepth 1 -type d \
      -exec rm -rf {} +
    catalog_changed=true
    log "  Removed stale ml-experiments catalog entries"
  fi

  local stale_groups
  stale_groups=$(find "${ROOT_DIR}/backstage/catalog/groups" -name "*.yaml" -not -name ".gitkeep" 2>/dev/null)
  if [[ -n "${stale_groups}" ]]; then
    find "${ROOT_DIR}/backstage/catalog/groups" -name "*.yaml" -not -name ".gitkeep" -delete
    catalog_changed=true
    log "  Removed stale group catalog entries"
  fi

  if [[ ${#removed[@]} -gt 0 ]]; then
    git -C "${ROOT_DIR}" add -A -- services/ 2>/dev/null || true
    if [[ "${catalog_changed}" == "true" ]]; then
      git -C "${ROOT_DIR}" add -A -- \
        backstage/catalog/ml-experiments/ \
        backstage/catalog/groups/ 2>/dev/null || true
    fi
    if ! git -C "${ROOT_DIR}" diff --cached --quiet 2>/dev/null; then
      git -C "${ROOT_DIR}" commit \
        -m "chore(cleanup): remove scaffolded services from platform repo [skip ci]" \
        2>/dev/null || true
      git -C "${ROOT_DIR}" push 2>/dev/null \
        || warn "  Could not push service cleanup to remote — commit the services/ deletions manually: ${removed[*]}"
    fi
  elif [[ "${catalog_changed}" == "true" ]]; then
    git -C "${ROOT_DIR}" add -A -- \
      backstage/catalog/ml-experiments/ \
      backstage/catalog/groups/ 2>/dev/null || true
    if ! git -C "${ROOT_DIR}" diff --cached --quiet 2>/dev/null; then
      git -C "${ROOT_DIR}" commit \
        -m "chore(cleanup): remove stale catalog entries [skip ci]" \
        2>/dev/null || true
      git -C "${ROOT_DIR}" push 2>/dev/null \
        || warn "  Could not push catalog cleanup to remote"
    fi
  fi

  log "  Scaffolded service cleanup complete."
}

# Shared placeholder-substitution engine, used by both setup.sh (first-time,
# interactive) and bootstrap-local.sh (day-2 standalone reruns). Previously each
# script carried its own copy of this logic with hand-maintained target-dir and
# exclusion lists that had drifted apart — a placeholder fixed in one script
# could still be missed by the other. Consolidating here keeps them identical.
#
# Reads resolved values via `${!name}` from already-exported MANIFEST_NAMES
# variables — setup.sh exports them from user prompts, bootstrap-local.sh
# exports them via load_idp_config() sourcing .idp-config.env. Requires
# load_placeholder_manifest to have been called first.
#
# On return, sets:
#   PERSONALIZATION_TARGETS — full candidate file list (newline-separated),
#                              for callers that need to run their own
#                              post-substitution checks (e.g. setup.sh's
#                              _verify_no_remaining).
run_personalization_pass() {
  # Union of every directory/file either script previously scanned.
  PERSONALIZATION_TARGETS=$(LC_ALL=C find \
    "${ROOT_DIR}/aws" \
    "${ROOT_DIR}/backstage/catalog" \
    "${ROOT_DIR}/backstage/app" \
    "${ROOT_DIR}/backstage/app-config.yaml" \
    "${ROOT_DIR}/backstage/app-config.local.yaml" \
    "${ROOT_DIR}/backstage/app-config.aws.yaml" \
    "${ROOT_DIR}/kubernetes" \
    "${ROOT_DIR}/local" \
    "${ROOT_DIR}/observability" \
    "${ROOT_DIR}/services" \
    "${ROOT_DIR}/terraform" \
    "${ROOT_DIR}/docs" \
    "${ROOT_DIR}/test-suites" \
    "${ROOT_DIR}/.github/workflows" \
    "${ROOT_DIR}/.github/CODEOWNERS" \
    "${ROOT_DIR}/.github/pull_request_template.md" \
    "${ROOT_DIR}/CONTRIBUTING.md" \
    "${ROOT_DIR}/CHANGELOG.md" \
    "${ROOT_DIR}/README.md" \
    "${ROOT_DIR}/mkdocs.yml" \
    \( -type d \( \
        -name node_modules -o \
        -name .yarn -o \
        -name dist -o \
        -name dist-types -o \
        -name .next -o \
        -name build -o \
        -name coverage -o \
        -name .terraform \
      \) -prune \) -o \
    \( -type f \
      ! -name '*.png' ! -name '*.jpg' ! -name '*.jpeg' ! -name '*.ico' \
      ! -name '*.gif' ! -name '*.svg' \
      ! -name '*.woff' ! -name '*.woff2' ! -name '*.ttf' ! -name '*.eot' \
      ! -name 'yarn.lock' ! -name 'package-lock.json' ! -name 'pnpm-lock.yaml' \
      ! -name 'go.sum' \
      ! -name '*.tsbuildinfo' ! -name '*.gz' ! -name '*.tgz' ! -name '*.zip' ! -name '*.tar' \
      -print \) \
    2>/dev/null) || true

  # Build sed -e args + grep needles from the manifest, reading resolved
  # values from already-exported shell variables named after MANIFEST_NAMES.
  local sed_args=() grep_patterns=()
  local i name placeholder literal value
  for i in "${!MANIFEST_NAMES[@]}"; do
    name="${MANIFEST_NAMES[$i]}"
    placeholder="${MANIFEST_PLACEHOLDERS[$i]}"
    literal="${MANIFEST_LITERALS[$i]}"
    value="${!name:-}"
    [[ -z "$value" || "$value" == "$placeholder" ]] && continue
    # Use | as sed delimiter so values containing / (e.g. DOCS_REPO_URL = https://...)
    # don't break the s/// expression.
    sed_args+=(-e "s|${placeholder}|${value}|g")
    sed_args+=(-e "s|\${{ ${placeholder} }}|${value}|g")
    grep_patterns+=("${placeholder}")
    if [[ -n "$literal" && "$value" != "$literal" ]]; then
      sed_args+=(-e "s|${literal}|${value}|g")
      grep_patterns+=("${literal}")
    fi
  done

  # Legacy YOUR_ORG alias — PACTFLOW_ORG if set, else GITHUB_ORG.
  local legacy_org=""
  if [[ -n "${PACTFLOW_ORG:-}" && "$PACTFLOW_ORG" != "YOUR_PACTFLOW_ORG" ]]; then
    legacy_org="$PACTFLOW_ORG"
  elif [[ -n "${GITHUB_ORG:-}" && "$GITHUB_ORG" != "YOUR_GITHUB_ORG" ]]; then
    legacy_org="$GITHUB_ORG"
  fi
  if [[ -n "$legacy_org" && "$legacy_org" != "YOUR_ORG" ]]; then
    sed_args+=(-e "s|YOUR_ORG|${legacy_org}|g")
    grep_patterns+=("YOUR_ORG")
  fi

  if [[ ${#sed_args[@]} -eq 0 ]]; then
    log "Personalisation: no resolved values — nothing to apply."
    return
  fi

  local grep_e_args=()
  for p in "${grep_patterns[@]}"; do
    grep_e_args+=(-e "$p")
  done

  # Pre-filter: only files containing at least one placeholder/literal token.
  local matching
  matching=$(printf '%s\n' "$PERSONALIZATION_TARGETS" \
    | grep -v '^$' \
    | tr '\n' '\0' \
    | xargs -0 grep -l -F ${grep_e_args[@]+"${grep_e_args[@]}"} 2>/dev/null || true)

  if [[ -z "$matching" ]]; then
    log "Personalisation: no remaining placeholders (GITHUB_ORG=${GITHUB_ORG:-}) — skipping."
    return
  fi

  local count scanned
  count=$(printf '%s\n' "$matching" | grep -c . || true)
  scanned=$(printf '%s\n' "$PERSONALIZATION_TARGETS" | grep -c . || true)
  log "Applying personalisation from manifest (GITHUB_ORG=${GITHUB_ORG:-})"

  # One sed invocation over every matching file (xargs may split it into a
  # handful of batches for ARG_MAX), instead of one sed process per file. On
  # this repo that is ~230 files: measured 5.9s per-file versus 0.2s batched.
  # sed is invoked directly rather than through _sed because xargs cannot call
  # a shell function — so resolve the in-place flag first.
  _sed_flavor_init
  if [[ "$_SED_FLAVOR" == gnu ]]; then
    printf '%s\n' "$matching" | grep -v '^$' | tr '\n' '\0' \
      | xargs -0 sed -i "${sed_args[@]}" 2>/dev/null || true
  else
    printf '%s\n' "$matching" | grep -v '^$' | tr '\n' '\0' \
      | xargs -0 sed -i '' "${sed_args[@]}" 2>/dev/null || true
  fi

  log "Substituted in ${count} of ${scanned} files (skipped $((scanned - count)) with no match)."
}

_preflight_check_local() {
  local missing=()
  local required_cmds=(kubectl helm docker)
  [[ "${KUBERNETES_PROVIDER:-kind}" == "kind" ]] && required_cmds+=(kind)
  for cmd in "${required_cmds[@]}"; do
    command -v "$cmd" &>/dev/null || missing+=("$cmd")
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    err "Missing required tools: ${missing[*]}
Install them and re-run, or run manually:
  ./scripts/bootstrap-local.sh"
  fi

  # Docker daemon must actually be running — `docker info` is the cheap check.
  if ! docker info >/dev/null 2>&1; then
    err "Docker daemon is not reachable. Start Docker Desktop / Rancher Desktop and re-run."
  fi

  # Free disk on the partition holding Docker storage — the Backstage build
  # alone needs ~5GB, and the cluster + observability stack chews through more.
  local free_gb
  if [[ "$(uname)" == "Darwin" ]]; then
    free_gb=$(df -g / 2>/dev/null | awk 'NR==2{print $4}')
  else
    free_gb=$(df -BG / 2>/dev/null | awk 'NR==2{gsub("G","",$4); print $4}')
  fi
  if [[ -n "${free_gb:-}" ]] && (( free_gb < 10 )); then
    warn "Low free disk (${free_gb}G on /). Bootstrap needs ~10G headroom; consider freeing space before proceeding."
  fi

  # CPU/memory allocated to the Docker daemon (on Docker Desktop this is the
  # VM's allocation, not the host's total). The full local stack — ArgoCD,
  # Kyverno, Gatekeeper, Prometheus/Grafana/Loki, kagent's ~15 agent pods,
  # and every MCP server — regularly saturates 4 CPUs / 8GB under normal
  # operation: control-plane components (kube-controller-manager,
  # argocd-repo-server, kyverno-admission-controller) lose their leader-
  # election lease or fail health probes under that contention and
  # crashloop, which surfaces as unrelated-looking deploy failures far later
  # in bootstrap (e.g. "deployments.apps ... NotFound", webhook "connection
  # refused"). This is a warning, not a hard stop — it's degraded, not
  # broken — but it's worth surfacing before 20 minutes of install rather
  # than during a confusing failure at step 12.
  local docker_ncpu docker_mem_bytes docker_mem_gb
  docker_ncpu=$(docker info --format '{{.NCPU}}' 2>/dev/null || echo "")
  docker_mem_bytes=$(docker info --format '{{.MemTotal}}' 2>/dev/null || echo "")
  if [[ -n "$docker_ncpu" && -n "$docker_mem_bytes" ]]; then
    docker_mem_gb=$(( docker_mem_bytes / 1024 / 1024 / 1024 ))
    if (( docker_ncpu < 6 || docker_mem_gb < 12 )); then
      warn "Docker has ${docker_ncpu} CPU(s) / ${docker_mem_gb}GiB allocated — the full local stack (ArgoCD, Kyverno, Gatekeeper, observability, kagent, all MCP servers) tends to saturate anything below ~6 CPUs / 12GiB, causing control-plane components to crashloop under load and deploys to fail with confusing errors well after this point. If you're on Docker Desktop: Settings → Resources → raise CPUs to 6+ and Memory to 12GiB+, then Apply & Restart. Continuing anyway..."
    fi
  fi
}

# ── Backstage AI-layer overlay ────────────────────────────────────────────────
# Writes local/backstage/app-config.ai.yaml, the third --config layer that the
# Backstage container always loads (see local/backstage/docker-compose.yml).
#
# Usage: write_backstage_ai_overlay true|false
#
# One implementation on purpose: bootstrap-local.sh writes it with the AI layer
# off, bootstrap-ai.sh writes it on (and `--destroy` writes it off again). Two
# copies of this list would drift the moment an AI page is added.
#
# Backstage does NOT deep-merge arrays — this app.extensions list replaces the
# one in backstage/app-config.yaml wholesale, so it must repeat every entry
# that file declares, not just the ones being flipped.
write_backstage_ai_overlay() {
  local enabled="${1:?write_backstage_ai_overlay requires true|false}"
  local disabled
  # A page is disabled exactly when the AI layer is not enabled.
  if [[ "$enabled" == "true" ]]; then disabled=false; else disabled=true; fi

  # bootstrap-local.sh calls the repo root ROOT_DIR, bootstrap-ai.sh calls it
  # REPO_ROOT. Accept either so this helper works unchanged from both.
  local out="${ROOT_DIR:-${REPO_ROOT:-$(pwd)}}/local/backstage/app-config.ai.yaml"
  mkdir -p "$(dirname "$out")"
  cat > "$out" <<EOF
# GENERATED by scripts/lib.sh (write_backstage_ai_overlay) — do not edit.
# Rewritten by bootstrap-local.sh (AI off) and bootstrap-ai.sh (AI on/--destroy).
# Gitignored. Hand edits are lost on the next bootstrap run.
app:
  extensions:
    # NOT AI-related, and NOT optional. This list replaces the app.extensions
    # array from *every* earlier layer (base app-config.yaml AND
    # app-config.local.yaml), because Backstage replaces arrays rather than
    # merging them. app-config.local.yaml disables page:kubernetes — the
    # standalone Kubernetes route renders the entity Kubernetes tab outside any
    # entity context and dies with "Entity context is not available". Dropping
    # the entry here silently brings that crash back, so it is repeated.
    # Anything added to an earlier layer's app.extensions must be added here too.
    - page:kubernetes:
        disabled: true
    - page:custom-pages/ai-assistant:
        disabled: ${disabled}
    - nav-item:custom-pages/ai-assistant:
        disabled: ${disabled}
    - page:custom-pages/ai-search:
        disabled: ${disabled}
    - nav-item:custom-pages/ai-search:
        disabled: ${disabled}
    - page:custom-pages/approvals:
        disabled: ${disabled}
    - nav-item:custom-pages/approvals:
        disabled: ${disabled}
    - page:custom-pages/kagent-platform:
        disabled: ${disabled}
    - nav-item:custom-pages/kagent-platform:
        disabled: ${disabled}
    - page:custom-pages/mlflow-platform:
        disabled: ${disabled}
    - nav-item:custom-pages/mlflow-platform:
        disabled: ${disabled}

aiStack:
  enabled: ${enabled}
EOF
}

# ── Backstage ConfigMaps (AWS/EKS) ────────────────────────────────────────────
# Generates the two ConfigMaps the in-cluster Backstage mounts as its --config
# layers (see aws/backstage/deployment.yaml) directly from the source files.
#
# Usage: apply_backstage_configmaps [kubectl-context]
#
# These used to live as a hand-maintained second copy of both config files
# embedded in a committed kubernetes/backstage/configmap.yaml (now deleted).
# Since AWS reads *only* the
# ConfigMaps, editing backstage/app-config*.yaml had no effect there, and the
# copies silently rotted:
#
#   - the base copy still used the broken `custom-pages/page:ai-assistant`
#     extension ID format (correct is `page:custom-pages/ai-assistant`), so
#     every AI gating flag was inert, and it carried no `aiStack` key at all;
#   - the AWS copy declared a one-entry `catalog.locations`, which — because
#     Backstage replaces arrays rather than merging them — wiped all 17 file
#     locations from the base layer. hello-service, the APIs, groups, domains
#     and ML experiments were all missing from the catalog on EKS.
#
# Generating removes the whole class of bug. There is nothing to keep in sync.
apply_backstage_configmaps() {
  local ctx="${1:-}"
  local root="${ROOT_DIR:-${REPO_ROOT:-$(pwd)}}"
  local -a ctx_args=()
  [[ -n "$ctx" ]] && ctx_args=(--context "$ctx")

  local base="${root}/backstage/app-config.yaml"
  local aws="${root}/backstage/app-config.aws.yaml"
  [[ -f "$base" ]] || { err "missing ${base}"; return 1; }
  [[ -f "$aws"  ]] || { err "missing ${aws}";  return 1; }

  # --dry-run=client needs no cluster; the context applies to `kubectl apply`.
  kubectl create configmap backstage-base-config -n backstage \
    --from-file=app-config.yaml="$base" \
    --dry-run=client -o yaml | kubectl apply "${ctx_args[@]}" -f -
  kubectl create configmap backstage-config -n backstage \
    --from-file=app-config.aws.yaml="$aws" \
    --dry-run=client -o yaml | kubectl apply "${ctx_args[@]}" -f -
}
