#!/usr/bin/env bash
# bootstrap-ai.sh — Install the AI/ML/MCP platform stack.
# Run after bootstrap-local.sh (local Kind) or bootstrap.sh (AWS/EKS).
#
# Usage: ./scripts/bootstrap-ai.sh [OPTIONS]
#
# Options:
#   --aws              Deploy to AWS/EKS instead of local Kind
#   --region <region>  AWS region (default: us-east-1, used with --aws)
#   --cluster <name>   EKS cluster name (default: idp-mvp, used with --aws)
#   --skip-mlflow      Skip MLflow tracking server
#   --skip-kagent      Skip KAgent CRDs and Helm install
#   --skip-mcp         Skip IDP/QA/Contract MCP Server build and deploy
#   --adp              Also deploy Agentic Development Platform (ADP) components
#                       (see docs/agentic-platform.md) on top of the base AI/ML stack
#   --destroy          Remove AI/ML components only (keeps core platform running)

set -euo pipefail

DEPLOY_MODE="local"
AWS_REGION="${AWS_REGION:-us-east-1}"
CLUSTER_NAME="${CLUSTER_NAME:-idp-mvp}"
SKIP_MLFLOW=false
SKIP_KAGENT=false
SKIP_MCP=false
ADP=false
DESTROY=false
FORCE_BUILD=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --aws)          DEPLOY_MODE="aws"; shift ;;
    --region)       AWS_REGION="$2"; shift 2 ;;
    --cluster)      CLUSTER_NAME="$2"; shift 2 ;;
    --skip-mlflow)  SKIP_MLFLOW=true; shift ;;
    --skip-kagent)  SKIP_KAGENT=true; shift ;;
    --skip-mcp)     SKIP_MCP=true; shift ;;
    --adp)          ADP=true; shift ;;
    --destroy)      DESTROY=true; shift ;;
    --force-build)  FORCE_BUILD=true; shift ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${REPO_ROOT}/local/.env"
ROOT_DIR="$REPO_ROOT"

# Source shared helpers (provides append_hosts_file). The loggers below
# intentionally override lib.sh's plain log/warn so AI output stays prefixed
# with [ai], which is used as a visual distinguisher throughout this script.
# shellcheck source=scripts/lib.sh
source "${REPO_ROOT}/scripts/lib.sh"

info()  { echo "  [ai] $*"; }
check() { echo "✓ $*"; }
warn()  { echo "  [ai] WARNING: $*" >&2; }
log()   { echo "  [ai] $*"; }
die()   { echo "✗ ERROR: $*" >&2; exit 1; }

# Per-step wall-clock timings, printed as a slowest-first table on exit
# (including on failure). Set IDP_TIMING=0 to silence.
timer_enable_summary

# Where skip-if-unchanged fingerprints for Helm releases and Docker images are
# recorded. Shared with bootstrap-local.sh, which uses the same directory for
# its ArgoCD release fingerprint.
CACHE_DIR="${REPO_ROOT}/.idp-cache"
# Bounded parallelism for MCP server image builds. Deliberately not "all at
# once": these are npm-install-heavy Node builds and Docker Desktop is often
# provisioned with only a few CPUs (see bootstrap-local.sh's under-provisioned
# Docker warning), where oversubscribing makes the whole batch slower.
IDP_BUILD_JOBS="${IDP_BUILD_JOBS:-4}"

# ── Pre-flight ────────────────────────────────────────────────────────────────

command -v kubectl >/dev/null || die "kubectl not found"
command -v helm    >/dev/null || die "helm not found"
command -v docker  >/dev/null || die "docker not found"

# ── Destroy mode ──────────────────────────────────────────────────────────────

if $DESTROY; then
  info "Tearing down AI/ML platform components (core platform untouched)..."

  # Ingresses first — deleting the namespace races with finalizer cleanup.
  # Only delete ingresses for the active DEPLOY_MODE so a local destroy never
  # touches aws/ manifests (and vice versa).
  if [[ "$DEPLOY_MODE" == "aws" ]]; then
    kubectl delete -f "${REPO_ROOT}/aws/kagent/ingress.yaml"                2>/dev/null || true
    kubectl delete -f "${REPO_ROOT}/aws/kagent/ingress-idp-assistant.yaml"  2>/dev/null || true
  else
    kubectl delete -f "${REPO_ROOT}/local/kagent/ingress.yaml"              2>/dev/null || true
    kubectl delete -f "${REPO_ROOT}/local/kagent/ingress-idp-assistant.yaml" 2>/dev/null || true
  fi

  # KAgent Helm releases + resources
  helm uninstall kagent      --namespace kagent 2>/dev/null || true
  helm uninstall kagent-crds --namespace kagent 2>/dev/null || true
  kubectl delete -f "${REPO_ROOT}/kubernetes/kagent/platform-agent.yaml"  2>/dev/null || true
  kubectl delete -f "${REPO_ROOT}/kubernetes/kagent/idp-agent.yaml"       2>/dev/null || true
  kubectl delete -f "${REPO_ROOT}/kubernetes/kagent/qa-agent.yaml"        2>/dev/null || true
  kubectl delete -f "${REPO_ROOT}/kubernetes/kagent/idp-mcp-server-rbac.yaml" 2>/dev/null || true
  kubectl delete -f "${REPO_ROOT}/kubernetes/kagent/toolserver.yaml"      2>/dev/null || true
  kubectl delete -f "${REPO_ROOT}/kubernetes/kagent/qa-toolserver.yaml"   2>/dev/null || true
  kubectl delete -f "${REPO_ROOT}/kubernetes/kagent/github-toolserver.yaml" 2>/dev/null || true
  kubectl delete -f "${REPO_ROOT}/kubernetes/kagent/argocd-toolserver.yaml" 2>/dev/null || true
  kubectl delete -f "${REPO_ROOT}/kubernetes/kagent/cost-toolserver.yaml"   2>/dev/null || true
  kubectl delete -f "${REPO_ROOT}/kubernetes/kagent/release-agent.yaml"     2>/dev/null || true
  kubectl delete -f "${REPO_ROOT}/kubernetes/kagent/cost-agent.yaml"        2>/dev/null || true
  # ADP components (docs/agentic-platform.md) — torn down unconditionally so a
  # destroy always fully cleans up regardless of which --adp phases were applied.
  kubectl delete -f "${REPO_ROOT}/kubernetes/kagent/incident-agent.yaml"      2>/dev/null || true
  kubectl delete -f "${REPO_ROOT}/kubernetes/kagent/incident-toolserver.yaml" 2>/dev/null || true
  kubectl delete -f "${REPO_ROOT}/kubernetes/kagent/security-agent.yaml"      2>/dev/null || true
  kubectl delete -f "${REPO_ROOT}/kubernetes/kagent/security-toolserver.yaml" 2>/dev/null || true
  kubectl delete -f "${REPO_ROOT}/kubernetes/kagent/security-mcp-server-rbac.yaml" 2>/dev/null || true
  kubectl delete -f "${REPO_ROOT}/kubernetes/kagent/onboarding-agent.yaml"    2>/dev/null || true
  helm uninstall incident-mcp-server --namespace services-dev 2>/dev/null || true
  helm uninstall security-mcp-server --namespace services-dev 2>/dev/null || true
  helm uninstall approval-service    --namespace services-dev 2>/dev/null || true
  kubectl delete secret incident-mcp-server-secrets -n services-dev 2>/dev/null || true
  kubectl delete secret approval-service-db          -n services-dev 2>/dev/null || true
  kubectl delete configmap approval-service-policy   -n services-dev 2>/dev/null || true
  kubectl delete -f "${REPO_ROOT}/kubernetes/kagent/modelconfig.yaml"         2>/dev/null || true
  kubectl delete -f "${REPO_ROOT}/kubernetes/kagent/modelconfig-haiku.yaml"   2>/dev/null || true
  kubectl delete -f "${REPO_ROOT}/kubernetes/kagent/modelconfig-openai.yaml"  2>/dev/null || true
  kubectl delete -f "${REPO_ROOT}/kubernetes/kagent/modelconfig-sonnet.yaml"  2>/dev/null || true
  kubectl delete -f "${REPO_ROOT}/kubernetes/kagent/modelconfig-opus.yaml"    2>/dev/null || true
  helm uninstall agent-event-router --namespace services-dev 2>/dev/null || true
  kubectl delete secret kagent-anthropic -n kagent 2>/dev/null || true
  kubectl delete secret kagent-openai -n kagent 2>/dev/null || true
  # Residue from the pre-fe4fce2 HTTPS-with-mkcert install. Harmless once the
  # new HTTP-only ingress is applied, but its presence on second machines is a
  # reliable fingerprint of "you upgraded across the TLS removal" — purge it
  # so future debugging sessions don't chase a red herring.
  kubectl delete secret kagent-tls -n kagent 2>/dev/null || true

  # MLflow — shared manifest + env-specific overlay
  kubectl delete -f "${REPO_ROOT}/kubernetes/ml-platform/mlflow.yaml" 2>/dev/null || true
  if [[ "$DEPLOY_MODE" == "aws" ]]; then
    kubectl delete -f "${REPO_ROOT}/aws/ml-platform/mlflow.yaml" 2>/dev/null || true
  fi

  # KAgent contract resources
  kubectl delete -f "${REPO_ROOT}/kubernetes/kagent/contract-toolserver.yaml" 2>/dev/null || true
  kubectl delete -f "${REPO_ROOT}/kubernetes/kagent/contract-agent.yaml"      2>/dev/null || true

  # MCP servers (services-dev namespace)
  helm uninstall idp-mcp-server      --namespace services-dev 2>/dev/null || true
  helm uninstall qa-mcp-server       --namespace services-dev 2>/dev/null || true
  helm uninstall contract-mcp-server --namespace services-dev 2>/dev/null || true
  helm uninstall github-mcp-server   --namespace services-dev 2>/dev/null || true
  helm uninstall argocd-mcp-server   --namespace services-dev 2>/dev/null || true
  helm uninstall cost-mcp-server     --namespace services-dev 2>/dev/null || true
  # AI-stack service secrets
  kubectl delete secret github-mcp-server-token     -n services-dev 2>/dev/null || true
  kubectl delete secret argocd-mcp-server-token     -n services-dev 2>/dev/null || true
  kubectl delete secret agent-event-router-secrets  -n services-dev 2>/dev/null || true
  # Remove services-dev only if it is now empty
  if [[ -z "$(kubectl get all -n services-dev --ignore-not-found -o name 2>/dev/null)" ]]; then
    kubectl delete namespace services-dev 2>/dev/null || true
  else
    warn "services-dev still has resources — namespace left in place."
  fi

  # Delete namespaces (waits for all pods to terminate).
  # Issue the deletes in background so we can also unblock the namespace
  # controller — a stale APIService anywhere in the cluster (e.g. metrics-server
  # marked False/FailedDiscoveryCheck) freezes every namespace finalizer.
  kubectl delete namespace kagent ml-platform --wait=false 2>/dev/null || true

  # Prune any non-Available APIServices that would stall NamespaceDeletionDiscoveryFailure.
  for svc in $(kubectl get apiservice -o json 2>/dev/null \
      | python3 -c "import json,sys
for i in json.load(sys.stdin).get('items',[]):
  for c in i.get('status',{}).get('conditions',[]):
    if c.get('type')=='Available' and c.get('status')!='True':
      print(i['metadata']['name']); break" 2>/dev/null); do
    warn "Pruning stale APIService $svc (would block namespace deletion)."
    kubectl delete apiservice "$svc" --ignore-not-found 2>/dev/null || true
  done

  # Wait up to 3m for the namespaces to actually disappear.
  for _ in $(seq 1 90); do
    remaining=$(kubectl get ns kagent ml-platform --no-headers 2>/dev/null | wc -l | tr -d ' ')
    [[ "$remaining" == "0" ]] && break
    sleep 2
  done

  info "Done. Re-run ./scripts/bootstrap-ai.sh to reinstall."
  exit 0
fi

if [[ "$DEPLOY_MODE" == "aws" ]]; then
  command -v aws >/dev/null || die "aws CLI not found"
  aws sts get-caller-identity &>/dev/null || die "AWS credentials not configured"
  ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
  REGISTRY="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${CLUSTER_NAME}"
  tf_outputs_load "${REPO_ROOT}/terraform"
  # Ensure ECR repos exist for all MCP server images (idempotent).
  # Repo names must match the Terraform convention: ${CLUSTER_NAME}/${repo}
  # so that the REGISTRY path (…/${CLUSTER_NAME}/${repo}) resolves correctly.
  # None of these have a Terraform-managed ECR repo (unlike idp/qa/contract, which
  # predate this loop) — without creating them here, docker push fails outright.
  _ecr_repos=(idp-mcp-server qa-mcp-server contract-mcp-server agent-event-router \
              github-mcp-server argocd-mcp-server cost-mcp-server)
  if $ADP; then
    for _adp_svc in incident-mcp-server security-mcp-server approval-service; do
      [[ -d "${REPO_ROOT}/services/${_adp_svc}" ]] && _ecr_repos+=("${_adp_svc}")
    done
  fi
  # One describe call for the whole registry, filtered locally, instead of one
  # describe round trip per repo (up to 10 serial API calls). Listing without
  # --repository-names is deliberate: passing names for a repo that doesn't
  # exist yet fails the *entire* call with RepositoryNotFoundException.
  _existing_ecr=$(aws ecr describe-repositories --region "${AWS_REGION}" \
    --query 'repositories[].repositoryName' --output text 2>/dev/null | tr '\t' '\n')
  for _repo in "${_ecr_repos[@]}"; do
    _full_repo="${CLUSTER_NAME}/${_repo}"
    if printf '%s\n' "$_existing_ecr" | grep -qx "${_full_repo}"; then
      continue
    fi
    # Note: this used to be `describe || create && info`, which — because || and
    # && are left-associative — printed "Created" on the already-exists path too.
    if aws ecr create-repository \
        --repository-name "${_full_repo}" \
        --region "${AWS_REGION}" \
        --image-scanning-configuration scanOnPush=true \
        --image-tag-mutability MUTABLE \
        --query 'repository.repositoryUri' --output text >/dev/null; then
      info "Created ECR repository: ${_full_repo}"
    else
      warn "Could not create ECR repository ${_full_repo} — docker push for ${_repo} will fail."
    fi
  done

  # Login to ECR once; subsequent docker push calls reuse the session
  aws ecr get-login-password --region "${AWS_REGION}" | \
    docker login --username AWS --password-stdin \
      "${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
  # Fetch ANTHROPIC_API_KEY and OPENAI_API_KEY from Secrets Manager (if not already
  # in env) — one round trip, both keys parsed from the same JSON blob.
  if [[ -z "${ANTHROPIC_API_KEY:-}" || -z "${OPENAI_API_KEY:-}" ]]; then
    _kagent_secret_json=$(aws secretsmanager get-secret-value \
      --secret-id "idp-mvp/kagent" \
      --region "${AWS_REGION}" \
      --query 'SecretString' --output text 2>/dev/null || echo "{}")
    if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
      ANTHROPIC_API_KEY=$(python3 -c "import json,sys; print(json.loads(sys.argv[1] or '{}').get('ANTHROPIC_API_KEY',''))" "$_kagent_secret_json" 2>/dev/null || echo "")
    fi
    if [[ -z "${OPENAI_API_KEY:-}" ]]; then
      OPENAI_API_KEY=$(python3 -c "import json,sys; print(json.loads(sys.argv[1] or '{}').get('OPENAI_API_KEY',''))" "$_kagent_secret_json" 2>/dev/null || echo "")
    fi
  fi
else
  REGISTRY="localhost:5003"
  # Read provider from local/.env (set by setup.sh / user)
  _provider="${KUBERNETES_PROVIDER:-kind}"
  if [[ -f "${ENV_FILE}" ]]; then
    _provider="${_provider:-$(grep '^KUBERNETES_PROVIDER=' "${ENV_FILE}" | cut -d= -f2- | tr -d '"' || echo 'kind')}"
  fi
  if [[ "$_provider" == "kind" ]]; then
    kind get clusters 2>/dev/null | grep -q "." || die "No Kind cluster found. Run ./scripts/bootstrap-local.sh first."
  else
    kubectl cluster-info --context rancher-desktop &>/dev/null || \
      die "Rancher Desktop cluster not reachable. Start Rancher Desktop and run ./scripts/bootstrap-local.sh --provider rancher-desktop first."
  fi
  # Load all AI-stack env vars from local/.env if not already set in environment
  if [[ -f "${ENV_FILE}" ]]; then
    ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-$(grep '^ANTHROPIC_API_KEY=' "${ENV_FILE}" | cut -d= -f2- || true)}"
    OPENAI_API_KEY="${OPENAI_API_KEY:-$(grep '^OPENAI_API_KEY=' "${ENV_FILE}" | cut -d= -f2- || true)}"
    GITHUB_TOKEN="${GITHUB_TOKEN:-$(grep '^GITHUB_TOKEN=' "${ENV_FILE}" | cut -d= -f2- || true)}"
    ARGOCD_TOKEN="${ARGOCD_TOKEN:-$(grep '^ARGOCD_TOKEN=' "${ENV_FILE}" | cut -d= -f2- || true)}"
    GITHUB_WEBHOOK_SECRET="${GITHUB_WEBHOOK_SECRET:-$(grep '^GITHUB_WEBHOOK_SECRET=' "${ENV_FILE}" | cut -d= -f2- || true)}"
    WEBHOOK_TOKEN="${WEBHOOK_TOKEN:-$(grep '^WEBHOOK_TOKEN=' "${ENV_FILE}" | cut -d= -f2- || true)}"
  fi

  # Authenticate the `argocd` CLI for the "is <svc>-local already an ArgoCD
  # app?" check below (MCP server deploy loop). This is intentionally NOT
  # ARGOCD_TOKEN (the user-configured token above, used only for the
  # argocd-mcp-server's own runtime secret) — it's the admin session JWT
  # bootstrap-local.sh's Step 8 mints fresh on every run and writes to
  # local/backstage/.env. Without ARGOCD_SERVER/ARGOCD_AUTH_TOKEN set, every
  # `argocd app get` call below fails with "server address unspecified" and
  # is silently swallowed by `&>/dev/null`, so the script always concluded
  # "app not found" and fell back to a direct `helm install` — even when
  # ArgoCD already owned the resource, which then fails to adopt existing
  # ArgoCD-managed objects (e.g. a PodDisruptionBudget missing Helm's
  # meta.helm.sh/* ownership annotations).
  _argocd_cli_token_file="${REPO_ROOT}/local/backstage/.env"
  if [[ -f "$_argocd_cli_token_file" ]]; then
    ARGOCD_SERVER="${ARGOCD_SERVER:-argocd.idp.local}"
    ARGOCD_AUTH_TOKEN="${ARGOCD_AUTH_TOKEN:-$(grep '^ARGOCD_AUTH_TOKEN=' "$_argocd_cli_token_file" | cut -d= -f2- || true)}"
    export ARGOCD_SERVER ARGOCD_AUTH_TOKEN
  fi
fi

[[ -n "${ANTHROPIC_API_KEY:-}" ]] || die "ANTHROPIC_API_KEY is not set. Add it to local/.env (local) or to AWS Secrets Manager at idp-mvp/kagent (AWS)."
# OPENAI_API_KEY is optional; warn if not set but allow bootstrap to continue
if [[ -z "${OPENAI_API_KEY:-}" ]]; then
  warn "OPENAI_API_KEY is not set. OpenAI ModelConfig will not be functional. Add it to local/.env (local) or to AWS Secrets Manager at idp-mvp/kagent (AWS) to enable OpenAI agents."
fi

info "Starting AI platform bootstrap (Claude API, mode=${DEPLOY_MODE})..."
echo ""

# ── 0. /etc/hosts — AI platform entries ──────────────────────────────────────
# First, not last: this is the only step needing `sudo`, and running it at the
# end meant a long install finished by silently waiting on a password prompt.
# The entries are static 127.0.0.1 mappings independent of anything installed
# below. An already-correct /etc/hosts needs no sudo and stays silent.
if [[ "$DEPLOY_MODE" == "local" ]]; then
  timer_start "0. /etc/hosts"
  info "Checking /etc/hosts entries (may prompt for your password)..."
  append_hosts_file "${REPO_ROOT}/local/hosts-append.txt" \
    "mlflow|kagent|idp-assistant|idp-mcp-server|qa-mcp-server|contract-mcp-server|agent-event-router|github-mcp-server|argocd-mcp-server|cost-mcp-server"
  timer_end "0. /etc/hosts"
fi

# ── 0. MCP server images (built in the background) ───────────────────────────
# Building these images needs only Docker and a reachable registry — not the
# cluster, not KAgent, not MLflow. They used to be built one at a time at the
# very end of the run, so the whole KAgent chain (CRD --wait, controller and
# postgres rollouts, the controller API health poll) ran to completion first
# with the Docker daemon sitting idle. Start them here instead and join just
# before the deploy pass in section 6.

MCP_SERVICES=(idp-mcp-server qa-mcp-server contract-mcp-server agent-event-router github-mcp-server argocd-mcp-server cost-mcp-server)
if $ADP; then
  # ADP MCP servers land incrementally (see docs/agentic-platform.md) — only
  # build ones whose source directory actually exists yet.
  for _adp_svc in incident-mcp-server security-mcp-server approval-service; do
    [[ -d "${REPO_ROOT}/services/${_adp_svc}" ]] && MCP_SERVICES+=("${_adp_svc}")
  done
fi

# Does :0.1.0 for this service actually exist in the target registry? Used by
# image_unchanged so a wiped local registry (the normal state after
# `bootstrap-local.sh --destroy`) or a deleted ECR tag always forces a real
# rebuild, no matter what the recorded fingerprint says.
_mcp_tag_exists_cmd() {
  local svc="$1"
  if [[ "$DEPLOY_MODE" == "aws" ]]; then
    printf 'aws ecr describe-images --region %q --repository-name %q --image-ids imageTag=0.1.0' \
      "$AWS_REGION" "${CLUSTER_NAME}/${svc}"
  else
    printf 'curl -sf %q | grep -q %q' \
      "http://${REGISTRY}/v2/${svc}/tags/list" '"0.1.0"'
  fi
}

# Build + push one MCP server image, skipping both when the service source is
# byte-identical to the last successful build and the tag is still in the
# registry. This is what makes a no-change re-run cheap: previously every run
# rebuilt all 7-10 Node images from scratch.
_build_push_mcp_image() {
  local svc="$1"
  local fp_file="${CACHE_DIR}/image-${svc}.fingerprint"
  local src_hash; src_hash=$(dir_content_hash "${REPO_ROOT}/services/${svc}")

  if [[ "$FORCE_BUILD" != "true" ]] && \
     image_unchanged "$fp_file" "$src_hash" "$(_mcp_tag_exists_cmd "$svc")"; then
    info "${svc}: source unchanged and image present in registry — skipping build."
    return 0
  fi

  info "Building ${svc}..."
  if [[ "$DEPLOY_MODE" == "aws" ]]; then
    # --platform linux/amd64 runs under emulation on an Apple-Silicon host,
    # which is why the registry layer cache matters so much here: a repeat
    # build reuses layers instead of re-emulating every npm install step.
    # Falls back to plain `docker build` where buildx isn't available.
    if docker buildx version &>/dev/null; then
      docker buildx build \
        --platform linux/amd64 --provenance=false \
        --cache-from "type=registry,ref=${REGISTRY}/${svc}:buildcache" \
        --cache-to "type=registry,ref=${REGISTRY}/${svc}:buildcache,mode=max,image-manifest=true" \
        -t "${REGISTRY}/${svc}:0.1.0" \
        -t "${REGISTRY}/${svc}:latest" \
        --push \
        "${REPO_ROOT}/services/${svc}/"
    else
      docker build \
        --platform linux/amd64 --provenance=false \
        -t "${REGISTRY}/${svc}:0.1.0" \
        -t "${REGISTRY}/${svc}:latest" \
        "${REPO_ROOT}/services/${svc}/"
      docker push "${REGISTRY}/${svc}:0.1.0"
      docker push "${REGISTRY}/${svc}:latest"
    fi
  else
    docker build \
      -t "${REGISTRY}/${svc}:0.1.0" \
      -t "${REGISTRY}/${svc}:latest" \
      "${REPO_ROOT}/services/${svc}/"
    docker push "${REGISTRY}/${svc}:0.1.0"
    docker push "${REGISTRY}/${svc}:latest"
  fi

  # Only record the fingerprint once build AND push both succeeded, so a
  # failed push can never leave a fingerprint claiming the image is in the
  # registry when it isn't.
  helm_record_fingerprint "$fp_file" "$src_hash"
}

# Build every MCP image, at most IDP_BUILD_JOBS at a time. Bash 3.2 has no
# `wait -n`, so this drains a full batch before starting the next one rather
# than keeping a sliding window full — with a handful of similarly-sized Node
# builds the difference is small, and it keeps the bookkeeping simple.
# Returns non-zero if ANY build failed, after every build has been waited on.
_run_mcp_builds() {
  local rc=0 svc log
  local pids=() logs=() names=()

  # Nested so it can see this function's arrays (bash uses dynamic scoping).
  # Per _bg_join's contract: join every job first, aggregate, then decide —
  # never short-circuit mid-loop, which would leave siblings running detached.
  _drain_builds() {
    local j jrc
    for (( j = 0; j < ${#pids[@]}; j++ )); do
      jrc=0
      _bg_join "${pids[$j]}" "${logs[$j]}" || jrc=$?
      if (( jrc != 0 )); then
        warn "${names[$j]}: image build/push failed (exit ${jrc})."
        rc=1
      fi
    done
    pids=(); logs=(); names=()
  }

  for svc in "${MCP_SERVICES[@]}"; do
    log=$(mktemp)
    ( _build_push_mcp_image "$svc" ) >"$log" 2>&1 &
    pids+=("$!"); logs+=("$log"); names+=("$svc")
    if (( ${#pids[@]} >= IDP_BUILD_JOBS )); then
      _drain_builds
    fi
  done
  _drain_builds

  unset -f _drain_builds
  return "$rc"
}

_MCP_BUILD_PID=""
_MCP_BUILD_LOG=""
if [[ "$SKIP_MCP" != "true" ]]; then
  _MCP_BUILD_LOG=$(mktemp)
  _run_mcp_builds >"$_MCP_BUILD_LOG" 2>&1 &
  _MCP_BUILD_PID=$!
  info "Building ${#MCP_SERVICES[@]} MCP server images in the background (up to ${IDP_BUILD_JOBS} at a time); output is shown when they're joined in step 6."
fi

# Don't leave build shells running detached if the script dies before section 6
# joins them. (An in-flight `docker build` still finishes daemon-side; this is
# about not orphaning the shells that were waiting on it.) No-op on the normal
# path, where section 6 clears _MCP_BUILD_PID after joining.
# This supersedes the EXIT trap installed by timer_enable_summary above, so it
# has to re-invoke timer_summary itself.
_kill_background_jobs() {
  if [[ -n "${_MCP_BUILD_PID:-}" ]]; then
    pkill -P "$_MCP_BUILD_PID" 2>/dev/null || true
    kill "$_MCP_BUILD_PID" 2>/dev/null || true
    rm -f "${_MCP_BUILD_LOG:-}" 2>/dev/null || true
  fi
  # Set in section 3, joined in 5e.
  if [[ -n "${_MLFLOW_PID:-}" ]]; then
    kill "$_MLFLOW_PID" 2>/dev/null || true
    rm -f "${_MLFLOW_LOG:-}" 2>/dev/null || true
  fi
}
trap '_kill_background_jobs; timer_summary' EXIT

# ── 1. Namespaces ─────────────────────────────────────────────────────────────
timer_start "1. Namespaces"

# Wait for any of our target namespaces to finish terminating before re-applying.
# Uses the shared helper from lib.sh.
wait_namespace_clear kagent
wait_namespace_clear ml-platform

info "Applying namespaces (ml-platform, kagent)..."
# Retry on transient admission-webhook timeouts (gatekeeper or other validators
# may be briefly unresponsive while their pods restart). With failurePolicy=Fail
# a single 3s timeout would otherwise bomb the whole bootstrap.
ns_apply_attempts=0
until kubectl apply -f "${REPO_ROOT}/kubernetes/namespaces/namespaces.yaml" 2> /tmp/ns_apply_err.$$; do
  ns_apply_attempts=$((ns_apply_attempts + 1))
  if grep -qE "failed calling webhook|context deadline exceeded" /tmp/ns_apply_err.$$ && [[ $ns_apply_attempts -lt 6 ]]; then
    warn "Namespace apply hit a webhook timeout (attempt $ns_apply_attempts/5) — retrying in 10s."
    cat /tmp/ns_apply_err.$$ | tail -3
    sleep 10
    continue
  fi
  cat /tmp/ns_apply_err.$$
  rm -f /tmp/ns_apply_err.$$
  die "Failed to apply namespaces after $ns_apply_attempts attempts."
done
rm -f /tmp/ns_apply_err.$$
check "Namespaces ready"

# Repair any helm releases stuck in `pending-*` state from a prior interrupted
# run. Helm refuses subsequent upgrades with "another operation in progress"
# until the orphan revision secret is removed.
repair_stuck_helm_release() {
  local rel="$1" ns="$2"
  local status
  status=$(helm status "$rel" -n "$ns" -o json 2>/dev/null | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4 || true)
  if [[ "$status" == pending-* ]]; then
    warn "Helm release $rel/$ns is stuck in $status — removing orphan revision secret(s)."
    # Delete every secret whose revision is in pending-* state.
    local secret latest_good
    latest_good=$(helm history "$rel" -n "$ns" --max 20 -o json 2>/dev/null \
      | grep -oE '"revision":[0-9]+,"updated":"[^"]+","status":"(deployed|superseded)"' \
      | grep -oE '"revision":[0-9]+' | tail -1 | cut -d: -f2 || true)
    for secret in $(kubectl get secrets -n "$ns" -l "owner=helm,name=$rel" -o name 2>/dev/null); do
      local rev
      rev=$(echo "$secret" | grep -oE 'v[0-9]+$' | tr -d v)
      if [[ -n "$latest_good" && "$rev" -gt "$latest_good" ]]; then
        kubectl delete -n "$ns" "$secret" 2>/dev/null || true
      fi
    done
  fi
}
repair_stuck_helm_release kagent-crds kagent
repair_stuck_helm_release kagent      kagent

timer_end "1. Namespaces"

# ── 2. Anthropic API key secret ───────────────────────────────────────────────
timer_start "2. Secrets"

info "Creating kagent-anthropic secret in kagent namespace..."
kubectl create secret generic kagent-anthropic \
  --namespace kagent \
  --from-literal=ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY}" \
  --dry-run=client -o yaml | kubectl apply -f -
check "Secret kagent-anthropic ready"

# Create OpenAI secret if API key is provided
if [[ -n "${OPENAI_API_KEY:-}" ]]; then
  info "Creating kagent-openai secret in kagent namespace..."
  kubectl create secret generic kagent-openai \
    --namespace kagent \
    --from-literal=OPENAI_API_KEY="${OPENAI_API_KEY}" \
    --dry-run=client -o yaml | kubectl apply -f -
  check "Secret kagent-openai ready"
fi

# ── 2b. AI-stack service secrets (services-dev namespace) ────────────────────
# These secrets are required before the MCP server deploy loop runs. Services
# use optional: true on their secretKeyRef so they start with a warning rather
# than crash when a token is not configured locally.

kubectl create namespace services-dev --dry-run=client -o yaml | kubectl apply -f - 2>/dev/null || true

# github-mcp-server token (same GITHUB_TOKEN already used by Backstage scaffolder)
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  info "Creating github-mcp-server-token secret in services-dev..."
  kubectl create secret generic github-mcp-server-token \
    --namespace services-dev \
    --from-literal=token="${GITHUB_TOKEN}" \
    --dry-run=client -o yaml | kubectl apply -f -
  check "Secret github-mcp-server-token ready"
else
  warn "GITHUB_TOKEN not set — github-mcp-server will start without a GitHub token (PR tools will fail). Add GITHUB_TOKEN to local/.env."
fi

# argocd-mcp-server token
if [[ -n "${ARGOCD_TOKEN:-}" ]]; then
  info "Creating argocd-mcp-server-token secret in services-dev..."
  kubectl create secret generic argocd-mcp-server-token \
    --namespace services-dev \
    --from-literal=token="${ARGOCD_TOKEN}" \
    --dry-run=client -o yaml | kubectl apply -f -
  check "Secret argocd-mcp-server-token ready"
else
  warn "ARGOCD_TOKEN not set — argocd-mcp-server will start without an ArgoCD token (all ArgoCD tools will fail). Add ARGOCD_TOKEN to local/.env."
  warn "  Get token: argocd account generate-token --account admin (or kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d)"
fi

# agent-event-router secrets (GITHUB_WEBHOOK_SECRET + WEBHOOK_TOKEN + GITHUB_TOKEN)
_ghws="${GITHUB_WEBHOOK_SECRET:-}"
_wt="${WEBHOOK_TOKEN:-}"
_ghtok="${GITHUB_TOKEN:-}"
if [[ -n "$_ghws" || -n "$_wt" || -n "$_ghtok" ]]; then
  info "Creating agent-event-router-secrets in services-dev..."
  kubectl create secret generic agent-event-router-secrets \
    --namespace services-dev \
    --from-literal=github-webhook-secret="${_ghws:-placeholder-set-in-github-webhook}" \
    --from-literal=webhook-token="${_wt:-placeholder-set-webhook-token}" \
    --from-literal=github-token="${_ghtok:-placeholder-set-github-token}" \
    --dry-run=client -o yaml | kubectl apply -f -
  check "Secret agent-event-router-secrets ready"
else
  warn "GITHUB_WEBHOOK_SECRET and WEBHOOK_TOKEN not set — agent-event-router will start but /webhook/github will return 503."
  warn "  Add GITHUB_WEBHOOK_SECRET and WEBHOOK_TOKEN to local/.env, then re-run bootstrap-ai.sh."
fi
if [[ -z "$_ghtok" ]]; then
  warn "GITHUB_TOKEN not set — agent-event-router will start but automatic incident-issue creation on critical alerts is disabled."
fi

# incident-mcp-server secrets (ADP Phase 3 — send_notification's Slack webhook)
if $ADP; then
  if [[ -n "${SLACK_WEBHOOK_URL:-}" ]]; then
    info "Creating incident-mcp-server-secrets in services-dev..."
    kubectl create secret generic incident-mcp-server-secrets \
      --namespace services-dev \
      --from-literal=slack-webhook-url="${SLACK_WEBHOOK_URL}" \
      --dry-run=client -o yaml | kubectl apply -f -
    check "Secret incident-mcp-server-secrets ready"
  else
    warn "SLACK_WEBHOOK_URL not set — incident-agent's send_notification tool will return sent:false. Add SLACK_WEBHOOK_URL to local/.env to enable it."
  fi
fi

timer_end "2. Secrets"

# ── 3. MLflow ─────────────────────────────────────────────────────────────────
timer_start "3. MLflow (launch)"

_MLFLOW_PID=""
_MLFLOW_LOG=""

if [[ "$SKIP_MLFLOW" == "true" ]]; then
  info "Skipping MLflow (--skip-mlflow)."
else
  info "Deploying MLflow tracking server (in the background)..."
  # MLflow shares nothing with KAgent but the namespaces applied in step 1, and
  # its `rollout status` blocks for up to 180s. Run it alongside the KAgent
  # install rather than in front of it; joined at the end of section 4.
  # The Terraform outputs are read here, on the main thread, so a missing output
  # still aborts the script via die() — inside the background job it could not.
  if [[ "$DEPLOY_MODE" == "aws" ]]; then
    MLFLOW_BUCKET=$(tf_output mlflow_artifacts_bucket_name)
    [[ -n "$MLFLOW_BUCKET" ]] || die "Could not read mlflow_artifacts_bucket_name from Terraform outputs. Run terraform apply first."
    MLFLOW_ROLE_ARN=$(tf_output mlflow_role_arn)
    [[ -n "$MLFLOW_ROLE_ARN" ]] || die "Could not read mlflow_role_arn from Terraform outputs."
  fi

  _MLFLOW_LOG=$(mktemp)
  (
    set -e
    if [[ "$DEPLOY_MODE" == "aws" ]]; then
      sed "s|MLFLOW_ARTIFACTS_BUCKET_PLACEHOLDER|${MLFLOW_BUCKET}|g" \
        "${REPO_ROOT}/aws/ml-platform/mlflow.yaml" | kubectl apply -f -
      kubectl annotate serviceaccount mlflow \
        -n ml-platform \
        "eks.amazonaws.com/role-arn=${MLFLOW_ROLE_ARN}" \
        --overwrite
      kubectl rollout status deployment/mlflow -n ml-platform --timeout=180s
      check "MLflow deployed (S3 artifacts → s3://${MLFLOW_BUCKET}/artifacts)"
    else
      kubectl apply -f "${REPO_ROOT}/kubernetes/ml-platform/mlflow.yaml"
      kubectl rollout status deployment/mlflow -n ml-platform --timeout=180s
      check "MLflow deployed → http://mlflow.idp.local"
    fi
  ) >"$_MLFLOW_LOG" 2>&1 &
  _MLFLOW_PID=$!
fi

timer_end "3. MLflow (launch)"

# ── 4. KAgent ─────────────────────────────────────────────────────────────────
timer_start "4. KAgent install + patches"

if [[ "$SKIP_KAGENT" == "true" ]]; then
  info "Skipping KAgent (--skip-kagent)."
else
  # Pinned to the verified latest release (0.9.4).
  # 0.9.4 has two missing HTTP handlers (/api/modelproviderconfigs, /api/promptlibraries)
  # that return plain-text 404 and crash the Next.js UI. The nginx intercept patch below
  # fixes this by returning {"error":false,"data":[]} before requests reach the controller.
  KAGENT_CHART_VERSION="0.9.4"

  KAGENT_VALUES="${REPO_ROOT}/local/kagent/values.yaml"
  [[ "$DEPLOY_MODE" == "aws" ]] && KAGENT_VALUES="${REPO_ROOT}/aws/kagent/values.yaml"

  # Skip-if-unchanged (lib.sh): a re-run against an already-healthy cluster
  # shouldn't pay for two full `helm upgrade` cycles plus a 5m --wait when the
  # pinned chart version and values file are byte-identical to the last
  # successful install. Both fall through to a real install on any version bump,
  # values edit, or release Helm no longer reports as deployed.
  _crds_fp_file="${CACHE_DIR}/kagent-crds.fingerprint"
  _crds_fp="${KAGENT_CHART_VERSION}"
  _kagent_fp_file="${CACHE_DIR}/kagent.fingerprint"
  _kagent_fp="${KAGENT_CHART_VERSION}:$(_sha256 "$KAGENT_VALUES")"

  if helm_release_unchanged kagent-crds kagent "$_crds_fp_file" "$_crds_fp"; then
    info "KAgent CRDs already at v${KAGENT_CHART_VERSION} — skipping reinstall."
  else
    info "Installing KAgent CRDs via Helm (OCI registry, v${KAGENT_CHART_VERSION})..."
    helm upgrade --install kagent-crds \
      oci://ghcr.io/kagent-dev/kagent/helm/kagent-crds \
      --version "${KAGENT_CHART_VERSION}" \
      --namespace kagent \
      --create-namespace \
      --wait \
      --timeout 5m
    helm_record_fingerprint "$_crds_fp_file" "$_crds_fp"
  fi

  # --force-conflicts: Helm v4 uses server-side apply; the kubectl patches below
  # take field ownership on first install, so subsequent helm upgrades would
  # fail with "conflict with kubectl-patch" without this flag.
  # The chart's default top-level `registry: cr.kagent.dev` (inherited by
  # controller/ui/agent images whose own image.registry is empty) points at a
  # registry that doesn't actually host these images — the real images live at
  # ghcr.io (same host the OCI chart itself was just pulled from). Without this
  # override, kagent-controller and kagent-ui sit in ImagePullBackOff forever.
  if helm_release_unchanged kagent kagent "$_kagent_fp_file" "$_kagent_fp"; then
    info "KAgent already installed (v${KAGENT_CHART_VERSION}, values unchanged) — skipping reinstall."
  else
    info "Installing KAgent via Helm (OCI registry, v${KAGENT_CHART_VERSION})..."
    helm upgrade --install kagent \
      oci://ghcr.io/kagent-dev/kagent/helm/kagent \
      --version "${KAGENT_CHART_VERSION}" \
      --namespace kagent \
      --values "${KAGENT_VALUES}" \
      --set registry=ghcr.io \
      --force-conflicts
    helm_record_fingerprint "$_kagent_fp_file" "$_kagent_fp"
  fi
  # Don't --wait here: built-in Agent CRDs (argo-rollouts, cilium, etc.) take
  # longer than helm's wait window to reach Ready. Poll the controller pod only.
  # Run this on the skip path too — cheap when the Deployment is already
  # Available, and it still catches a pod knocked over since the last run.
  kubectl rollout status deployment/kagent-controller -n kagent --timeout=5m || \
    warn "kagent-controller not ready yet — pods are starting, will self-heal. Continuing..."

  check "KAgent installed (v${KAGENT_CHART_VERSION})"

  # ── 4b. Patch PostgreSQL to use pgvector image ───────────────────────────────
  # The KAgent helm chart (v0.9.2) does not propagate postgres.bundled.image or
  # postgres.vectorEnabled into the rendered Deployment/ConfigMap.  We patch
  # them directly so the `memory` table (vector(768) column) can be created.
  # Both patches are idempotent, but the rollouts they trigger are not free —
  # applying them unconditionally costs a postgres rollout plus a full
  # controller restart (two `rollout status --timeout=5m` waits) on every run.
  # Read the live state instead and skip the whole block when it's already
  # converged; any drift (fresh install, helm upgrade that reverted a field)
  # still falls through to the real patch path.
  _pg_image=$(kubectl get deployment kagent-postgresql -n kagent \
    -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || echo "")
  _vector_enabled=$(kubectl get configmap kagent-controller -n kagent \
    -o jsonpath='{.data.DATABASE_VECTOR_ENABLED}' 2>/dev/null || echo "")

  # The controller used to be restarted twice per run: once here (to pick up
  # DATABASE_VECTOR_ENABLED) and again in section 5 (to reconcile the Agent CRs
  # applied after it came up), each with its own multi-minute rollout wait. The
  # restart now happens once, after the Agent manifests are applied — see
  # "5c. Restart kagent-controller" below. This flag records whether it's needed.
  _ctrl_restart_needed=false

  if [[ "$_pg_image" == "pgvector/pgvector:pg18" && "$_vector_enabled" == "true" ]]; then
    check "pgvector image + DATABASE_VECTOR_ENABLED already applied — skipping patch and controller restart."
  else
    _ctrl_restart_needed=true
    info "Patching kagent-postgresql to pgvector image and enabling DATABASE_VECTOR_ENABLED..."

    # Switch the bundled postgres to the pgvector-enabled image.
    # --field-manager=helm: claim ownership as helm so the next helm upgrade can
    # overwrite these fields without a server-side-apply conflict.
    kubectl patch deployment kagent-postgresql -n kagent \
      --field-manager=helm \
      --type='json' \
      --patch='[{"op":"replace","path":"/spec/template/spec/containers/0/image","value":"pgvector/pgvector:pg18"},{"op":"replace","path":"/spec/template/spec/containers/0/imagePullPolicy","value":"IfNotPresent"}]'
    kubectl rollout status deployment/kagent-postgresql -n kagent --timeout=5m || \
      warn "kagent-postgresql rollout slow (cold pgvector image + probe ramp-up) — continuing; will retry connection below."

    # Enable vector support in the controller ConfigMap.
    kubectl patch configmap kagent-controller -n kagent \
      --field-manager=helm \
      --patch='{"data":{"DATABASE_VECTOR_ENABLED":"true"}}'

    # Wait for postgres to be accepting connections, then create the extension.
    PG_POD=$(kubectl get pod -n kagent --no-headers | awk '/postgresql/{print $1;exit}')
    for i in $(seq 1 20); do
      if kubectl exec -n kagent "$PG_POD" -- psql -U kagent -d kagent -c "SELECT 1" &>/dev/null 2>&1; then
        break
      fi
      sleep 3
    done
    kubectl exec -n kagent "$PG_POD" -- \
      psql -U kagent -d kagent -c "CREATE EXTENSION IF NOT EXISTS vector;" 2>&1 || true
    check "pgvector extension enabled → memory table will be created on controller restart"
  fi

  timer_end "4. KAgent install + patches"

  # ── 5. KAgent resources ─────────────────────────────────────────────────────
  timer_start "5. KAgent resources"

  info "Applying KAgent ModelConfig, Ingress, agents, and MCP server registrations..."
  # One `kubectl apply` with repeated -f instead of ~16 separate invocations:
  # these objects are independent (distinct ModelConfigs/RemoteMCPServers/
  # Agents), so there is nothing to order between them, and a single call pays
  # one process spawn and one client-side discovery round trip instead of 16.
  # contract-toolserver is required, not optional: idp-agent and platform-agent
  # both reference contract-mcp-server as a tool source, so without it those
  # agents fail to compile ("RemoteMCPServer.kagent.dev contract-mcp-server not found").
  _kagent_manifests=(
    modelconfig.yaml
    modelconfig-haiku.yaml
    modelconfig-sonnet.yaml
    modelconfig-opus.yaml
    idp-mcp-server-rbac.yaml
    toolserver.yaml
    idp-agent.yaml
    qa-toolserver.yaml
    qa-agent.yaml
    github-toolserver.yaml
    argocd-toolserver.yaml
    cost-toolserver.yaml
    release-agent.yaml
    cost-agent.yaml
    platform-agent.yaml
    contract-toolserver.yaml
    contract-agent.yaml
  )
  # Conditional — the OpenAI ModelConfig is only functional with a key present.
  [[ -n "${OPENAI_API_KEY:-}" ]] && _kagent_manifests+=(modelconfig-openai.yaml)

  _kagent_apply_args=()
  for _m in "${_kagent_manifests[@]}"; do
    _kagent_apply_args+=(-f "${REPO_ROOT}/kubernetes/kagent/${_m}")
  done
  kubectl apply "${_kagent_apply_args[@]}"

  if $ADP; then
    info "Applying Agentic Development Platform (ADP) components (docs/agentic-platform.md)..."
    # Populated incrementally as ADP phases land — see docs/agentic-platform.md
    # for what each phase adds. Manifests referenced here are applied only if
    # present, so bootstrap-ai.sh --adp is always safe to run against whatever
    # ADP phases have shipped so far.
    for _adp_manifest in incident-toolserver.yaml incident-agent.yaml \
                         security-mcp-server-rbac.yaml security-toolserver.yaml security-agent.yaml \
                         onboarding-agent.yaml; do
      if [[ -f "${REPO_ROOT}/kubernetes/kagent/${_adp_manifest}" ]]; then
        kubectl apply -f "${REPO_ROOT}/kubernetes/kagent/${_adp_manifest}"
      fi
    done
  fi

  if [[ "$DEPLOY_MODE" == "aws" ]]; then
    # Apply ServiceMonitor for Prometheus scraping of MCP servers
  info "Applying Prometheus ServiceMonitor for kagent namespace..."
  kubectl apply -f "${REPO_ROOT}/kubernetes/monitoring/servicemonitor-kagent.yaml"
  check "ServiceMonitor applied — MCP metrics now scraped by Prometheus"

  # AWS: sync Anthropic API key via ExternalSecret + use ALB ingress
  if [[ "$DEPLOY_MODE" == "aws" ]]; then
    KAGENT_ESO_ROLE_ARN=$(tf_output kagent_eso_role_arn)
    [[ -n "$KAGENT_ESO_ROLE_ARN" ]] || die "Could not read kagent_eso_role_arn from Terraform outputs."
  fi
    sed "s|AWS_REGION_PLACEHOLDER|${AWS_REGION}|g" \
      "${REPO_ROOT}/aws/kagent/external-secret.yaml" | kubectl apply -f -
    kubectl annotate serviceaccount kagent-eso-sa \
      -n kagent \
      "eks.amazonaws.com/role-arn=${KAGENT_ESO_ROLE_ARN}" \
      --overwrite
    kubectl apply -f "${REPO_ROOT}/aws/kagent/ingress.yaml"
    kubectl apply -f "${REPO_ROOT}/aws/kagent/ingress-idp-assistant.yaml"
    check "IDP + QA + Contract agents defined (claude-haiku-4-5-20251001)"
    check "KAgent ExternalSecret → idp-mvp/kagent (Secrets Manager)"
    check "KAgent UI ingress → ALB (AWS Load Balancer Controller)"
    check "IDP Assistant A2A ingress → ALB (AWS Load Balancer Controller)"

    # Patch Backstage's externalLinks.kagent with the real ALB hostname, now
    # that the Ingress above exists — Backstage is already deployed by this
    # point (bootstrap.sh runs this script in Phase 6, after deploying
    # Backstage in Phase 5.6), so this is a separate patch+restart from the
    # ArgoCD/Grafana one bootstrap.sh does for its own two externalLinks.
    info "Waiting for KAgent UI LoadBalancer hostname..."
    KAGENT_URL=""
    for i in $(seq 1 36); do
      KAGENT_URL=$(kubectl get ingress kagent-ui -n kagent \
        -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || echo "")
      [[ -n "$KAGENT_URL" ]] && break
      sleep 10
    done
    if [[ -n "$KAGENT_URL" ]]; then
      kubectl get configmap backstage-config -n backstage -o json \
        | sed "s|KAGENT_ALB_URL|${KAGENT_URL}|g" \
        | kubectl apply -f -
      kubectl rollout restart deployment/backstage -n backstage
      check "externalLinks.kagent patched with ALB hostname"
    else
      warn "KAgent UI ALB hostname not ready — leaving externalLinks.kagent as a placeholder."
    fi
  else
    # Local: create API key secret directly + nginx ingresses (HTTP)
    # Delete first: machines that ran the pre-fe4fce2 bootstrap-ai.sh have
    # ingresses with a `tls:` block on disk in the cluster. `kubectl apply`
    # uses server-side apply with a different field manager, which can leave
    # the old `tls.secretName: kagent-tls` field behind — nginx then serves
    # its fake default certificate for HTTPS requests and the browser shows
    # a cert error. Recreating the ingress objects guarantees a clean spec.
    kubectl delete ingress kagent-ui idp-assistant -n kagent --ignore-not-found 2>/dev/null || true
    kubectl apply -f "${REPO_ROOT}/local/kagent/ingress.yaml"
    kubectl apply -f "${REPO_ROOT}/local/kagent/ingress-idp-assistant.yaml"
    check "IDP + QA + Contract agents defined (claude-haiku-4-5-20251001)"
    check "KAgent UI ingress → http://kagent.idp.local"
    check "IDP Assistant ingress → http://idp-assistant.idp.local"

    # ── 5c. SSR resolution ────────────────────────────────────────────────────
    # Next.js SSR API calls are routed via ui.backendInternalUrl in
    # local/kagent/values.yaml → kagent-controller.kagent.svc.cluster.local:8083
    # No hostAliases patch needed; the controller is reached directly in-cluster.
    check "kagent-ui SSR → kagent-controller.kagent.svc.cluster.local:8083"
  fi

  # ── 5b. Apply repo-managed nginx config to fix KAgent v0.9.4 broken UI pages ─
  # aws/kagent/nginx.conf (committed) contains two bug fixes for v0.9.4:
  #   Bug 1: /api/modelproviderconfigs + /api/promptlibraries return plain-text
  #          404 → JSON.parse() throws in Next.js → pages crash. Fixed with
  #          nginx intercept returning {"error":false,"data":[]}.
  #   Bug 2: crypto.randomUUID() requires HTTPS (secure context). Over HTTP the
  #          function is undefined → TypeError crash. Fixed with a sub_filter
  #          polyfill injected before </head>.
  #
  # After applying, we remove the Helm management annotations so that
  # `helm upgrade kagent` does NOT overwrite this ConfigMap. The source of truth
  # is aws/kagent/nginx.conf in the repo; bootstrap-ai.sh re-applies it each run.
  NGINX_CONF_SRC="${REPO_ROOT}/aws/kagent/nginx.conf"
  info "Applying repo nginx config to fix /agents/new and /prompts/new (KAgent v0.9.4 bugs)..."
  kubectl create configmap kagent-ui-config \
    --namespace kagent \
    --from-file=nginx.conf="${NGINX_CONF_SRC}" \
    --dry-run=client -o yaml | kubectl apply -f -
  # Disown from Helm so helm upgrade kagent does not overwrite this ConfigMap.
  kubectl annotate configmap kagent-ui-config -n kagent \
    meta.helm.sh/release-name- \
    meta.helm.sh/release-namespace- \
    --overwrite 2>/dev/null || true
  kubectl label configmap kagent-ui-config -n kagent \
    app.kubernetes.io/managed-by- \
    --overwrite 2>/dev/null || true
  check "nginx config applied from repo + disowned from Helm (upgrade-safe)"

  # ── 5c. Restart kagent-controller (once) ────────────────────────────────────
  # One restart now covers both reasons the controller used to be bounced twice
  # per run:
  #   1. picking up DATABASE_VECTOR_ENABLED=true from the 4b ConfigMap patch
  #      (and running the AutoMigrate that creates the memory table), and
  #   2. re-reconciling the Agent CRs applied just above — without it, agents
  #      created after the controller started can sit at "Deployment is not
  #      ready, 0/1 pods are ready" because the controller holds stale status.
  # Both are now upstream of this point, so the restart is done here, once.
  #
  # Skipped entirely when 4b found nothing to patch AND every Agent already
  # reports Ready=True — i.e. a converged re-run, where bouncing the controller
  # only costs a rollout and drops the UI for a moment.
  if [[ "$_ctrl_restart_needed" != "true" ]]; then
    _agents_total=$(kubectl get agents -n kagent --no-headers 2>/dev/null | wc -l | tr -d ' ')
    _agents_ready=$(kubectl get agents -n kagent \
      -o jsonpath='{range .items[*]}{.status.conditions[?(@.type=="Ready")].status}{"\n"}{end}' \
      2>/dev/null | grep -c '^True$' || true)
    if [[ "$_agents_total" == "0" || "$_agents_ready" != "$_agents_total" ]]; then
      info "  ${_agents_ready}/${_agents_total} agents Ready — restarting controller to reconcile."
      _ctrl_restart_needed=true
    fi
  fi

  if [[ "$_ctrl_restart_needed" == "true" ]]; then
    info "Restarting kagent-controller (pgvector config + agent reconcile)..."
    kubectl rollout restart deployment/kagent-controller -n kagent 2>/dev/null || true
    kubectl rollout status  deployment/kagent-controller -n kagent --timeout=5m 2>/dev/null || \
      warn "kagent-controller restart slow — agents will self-heal once it's ready."
    check "kagent-controller restarted → all agents reconciled to Ready"
  else
    check "kagent-controller already current and all agents Ready — no restart needed."
  fi

  # Wait for the controller HTTP API to be serving before the UI restarts against
  # it. rollout status only checks the pod readiness probe; the API needs extra
  # seconds to initialize its DB schema. Without this wait, SSR calls from
  # kagent-ui to /agents/new and /prompts/new hit the API before it's ready →
  # "This page couldn't load".
  info "Waiting for KAgent controller API to be ready..."
  # The controller image is distroless (no wget/curl/sh -c exec target), so we
  # can't exec into the pod to hit its health endpoint. Port-forward the
  # ClusterIP service instead and curl from the host, which has curl.
  _ctrl_ready=false
  kubectl -n kagent port-forward svc/kagent-controller 18083:8083 &>/dev/null &
  _ctrl_pf_pid=$!
  for i in $(seq 1 40); do
    if curl -sf -o /dev/null http://127.0.0.1:18083/health 2>/dev/null; then
      _ctrl_ready=true
      break
    fi
    sleep 5
  done
  kill "$_ctrl_pf_pid" &>/dev/null || true
  wait "$_ctrl_pf_pid" 2>/dev/null || true
  [[ "$_ctrl_ready" == "true" ]] && check "KAgent controller API healthy" || \
    warn "KAgent controller API health check timed out — UI pages may show errors on first load"

  # Restart kagent-ui so its Next.js SSR cache is rebuilt against the now-ready
  # controller. Without this, the cached SSR state from startup reflects the
  # pre-ready controller, causing /agents/new and /prompts/new to crash until
  # the pod is manually restarted.
  info "Restarting kagent-ui to pick up ready controller state..."
  kubectl rollout restart deployment/kagent-ui -n kagent 2>/dev/null || true
  kubectl rollout status  deployment/kagent-ui -n kagent --timeout=3m 2>/dev/null || \
    warn "kagent-ui restart slow — /agents/new and /prompts/new should load once it's ready."
  check "kagent-ui restarted → SSR cache rebuilt against ready controller"

fi

timer_end "5. KAgent resources"

# ── 5d. Join MLflow ───────────────────────────────────────────────────────────
# Launched back in section 3; by now it has had the whole KAgent install to roll
# out, so this is usually instant. Outside the KAgent if/else on purpose, so it
# still gets joined under --skip-kagent.
timer_start "5d. Join MLflow"
_bg_join "$_MLFLOW_PID" "$_MLFLOW_LOG" || \
  warn "MLflow deploy failed — check: kubectl get po -n ml-platform"
_MLFLOW_PID=""
timer_end "5d. Join MLflow"

# ── 6. IDP / QA MCP Servers ───────────────────────────────────────────────────
# Local: build images into the local registry; ArgoCD (services-dev namespace)
#        manages the actual Kubernetes deployment via GitOps.
# AWS:   build, push to ECR, and Helm-deploy directly (ArgoCD handles day-2).

# Clean up stale MCP server resources from previous runs (ServiceAccount, Deployment, etc.)
# that don't have Helm ownership metadata. Helm cannot "adopt" resources created outside
# of Helm, so we must delete them first to allow helm upgrade --install to create them cleanly.
cleanup_stale_mcp_resources() {
  local svc="$1"
  local ns="${2:-services-dev}"

  # Check if any of {ServiceAccount, Deployment, Service} exists with annotations
  # that don't match the expected Helm release (svc in services-dev). Helm cannot
  # adopt resources without matching ownership metadata, so we delete them all.
  #
  # ArgoCD-managed resources are exempt: ArgoCD renders the chart and applies it
  # directly (it never runs `helm install`), so its resources never carry
  # meta.helm.sh/* annotations in the first place. Without this exemption every
  # ArgoCD-owned Deployment/Service/ServiceAccount here reads as "mismatched" and
  # gets deleted on every single bootstrap run, only to be recreated later by
  # ArgoCD's own reconciliation (or not, if it's slower than the caller's wait
  # loop) — this was the real source of the "deployments.apps ... NotFound"
  # flakiness, not a timing race.
  local needs_cleanup=false
  for kind in serviceaccount deployment service; do
    if kubectl get "$kind" "$svc" -n "$ns" &>/dev/null; then
      local tracking_id
      tracking_id=$(kubectl get "$kind" "$svc" -n "$ns" -o jsonpath='{.metadata.annotations.argocd\.argoproj\.io/tracking-id}' 2>/dev/null || true)
      [[ -n "$tracking_id" ]] && continue
      local rel_name rel_ns
      rel_name=$(kubectl get "$kind" "$svc" -n "$ns" -o jsonpath='{.metadata.annotations.meta\.helm\.sh/release-name}' 2>/dev/null || true)
      rel_ns=$(kubectl get "$kind" "$svc" -n "$ns" -o jsonpath='{.metadata.annotations.meta\.helm\.sh/release-namespace}' 2>/dev/null || true)
      if [[ "$rel_name" != "$svc" || "$rel_ns" != "$ns" ]]; then
        needs_cleanup=true
        break
      fi
    fi
  done

  if [[ "$needs_cleanup" == "true" ]]; then
    log "Cleaning up stale ${svc} resources (Helm ownership metadata missing or mismatched)..."
    kubectl delete serviceaccount "$svc" -n "$ns" --ignore-not-found=true 2>/dev/null || true
    kubectl delete deployment "$svc" -n "$ns" --ignore-not-found=true 2>/dev/null || true
    kubectl delete service "$svc" -n "$ns" --ignore-not-found=true 2>/dev/null || true
    sleep 2
  fi
}

if [[ "$SKIP_MCP" == "true" ]]; then
  info "Skipping IDP/QA MCP Servers (--skip-mcp)."
else
  # AWS: create mcp-backstage-token secret in services-dev so MCP servers can
  # authenticate against the Backstage catalog API. The token value comes from
  # Secrets Manager (idp-mvp/backstage → BACKSTAGE_CATALOG_TOKEN) and must match
  # the externalAccess token configured in kubernetes/backstage/configmap.yaml.
  if [[ "$DEPLOY_MODE" == "aws" ]]; then
    info "Creating mcp-backstage-token secret in services-dev..."
    MCP_BS_TOKEN=$(aws secretsmanager get-secret-value \
      --secret-id "${CLUSTER_NAME}/backstage" \
      --query SecretString --output text 2>/dev/null \
      | python3 -c "import json,sys; s=json.load(sys.stdin); print(s.get('BACKSTAGE_CATALOG_TOKEN','REPLACE_ME'))" \
      2>/dev/null || echo "REPLACE_ME")
    if [[ "$MCP_BS_TOKEN" == "REPLACE_ME" ]]; then
      warn "BACKSTAGE_CATALOG_TOKEN not set in Secrets Manager — MCP servers won't authenticate to Backstage."
      warn "Update the secret: aws secretsmanager update-secret --secret-id ${CLUSTER_NAME}/backstage ..."
    fi
    kubectl create secret generic mcp-backstage-token \
      --from-literal=token="${MCP_BS_TOKEN}" \
      --namespace services-dev --dry-run=client -o yaml | kubectl apply -f -
    check "mcp-backstage-token secret created in services-dev"
  fi

  if [[ "$DEPLOY_MODE" == "aws" ]]; then
    CONTRACT_MCP_ROLE_ARN=$(tf_output contract_mcp_server_role_arn)
    [[ -n "$CONTRACT_MCP_ROLE_ARN" ]] || warn "Could not read contract_mcp_server_role_arn from Terraform outputs — contract-mcp-server will lack DynamoDB access."
  fi

  # MCP_SERVICES and the image builds themselves are set up much earlier (see
  # "0. MCP server images" above) so the builds overlap with the KAgent install.
  # Wait for them here — the deploy pass below needs the images in the registry.
  timer_start "6a. Join MCP image builds"
  _bg_join "$_MCP_BUILD_PID" "$_MCP_BUILD_LOG" || \
    warn "One or more MCP image builds failed — see the build output above. Affected services will fail to deploy."
  _MCP_BUILD_PID=""
  timer_end "6a. Join MCP image builds"
  timer_start "6b. Deploy MCP servers"

  if $ADP; then
    # Phase 4 HiTL approval gate prerequisites (docs/agentic-platform.md)
    if [[ -d "${REPO_ROOT}/services/approval-service" ]]; then
      info "Applying approval-service policy ConfigMap..."
      kubectl create namespace services-dev --dry-run=client -o yaml | kubectl apply -f - >/dev/null 2>&1 || true
      kubectl apply -f "${REPO_ROOT}/kubernetes/kagent/policies/configmap.yaml"
      check "ConfigMap approval-service-policy ready"

      if [[ "$DEPLOY_MODE" == "aws" ]]; then
        # approval-service reuses Backstage's own Aurora/RDS Postgres — copy the
        # connection secret across namespaces since K8s secrets are namespace-scoped.
        if kubectl get secret backstage-secrets -n backstage &>/dev/null; then
          info "Copying backstage-secrets (namespace: backstage) → approval-service-db (namespace: services-dev)..."
          kubectl create secret generic approval-service-db \
            --namespace services-dev \
            --from-literal=POSTGRES_HOST="$(kubectl get secret backstage-secrets -n backstage -o jsonpath='{.data.POSTGRES_HOST}' | base64 -d)" \
            --from-literal=POSTGRES_PORT="$(kubectl get secret backstage-secrets -n backstage -o jsonpath='{.data.POSTGRES_PORT}' | base64 -d)" \
            --from-literal=POSTGRES_USER="$(kubectl get secret backstage-secrets -n backstage -o jsonpath='{.data.POSTGRES_USER}' | base64 -d)" \
            --from-literal=POSTGRES_PASSWORD="$(kubectl get secret backstage-secrets -n backstage -o jsonpath='{.data.POSTGRES_PASSWORD}' | base64 -d)" \
            --from-literal=POSTGRES_DB="$(kubectl get secret backstage-secrets -n backstage -o jsonpath='{.data.POSTGRES_DB}' | base64 -d)" \
            --dry-run=client -o yaml | kubectl apply -f -
          check "Secret approval-service-db ready"
        else
          warn "backstage-secrets not found in namespace 'backstage' — approval-service will fail to start until it's created. Run bootstrap.sh first."
        fi
      fi
    fi
  fi

  for SVC in "${MCP_SERVICES[@]}"; do
    # Clean up stale resources from previous failed runs before deploying
    cleanup_stale_mcp_resources "$SVC" "services-dev"

    (
      set -e
      # No build here: the images were built by the background pass launched in
      # section 0 and joined in 6a above. This loop is deploy-only.
      if [[ "$DEPLOY_MODE" == "aws" ]]; then
        # Skip the `helm upgrade --install --wait 3m` when neither the image nor
        # the chart values changed and Helm still reports the release deployed.
        # The rollout status check still runs on the skip path — it's ~instant
        # for a healthy Deployment but still catches one that has fallen over.
        _svc_fp_file="${CACHE_DIR}/mcp-${SVC}.fingerprint"
        _svc_fp="$(dir_content_hash "${REPO_ROOT}/services/${SVC}"):$(_sha256 "${REPO_ROOT}/services/${SVC}/helm-values-aws.yaml")"
        if [[ "$FORCE_BUILD" != "true" ]] && \
           helm_release_unchanged "${SVC}" services-dev "$_svc_fp_file" "$_svc_fp"; then
          info "${SVC}: image and chart values unchanged — skipping Helm upgrade."
          kubectl rollout status deployment/"${SVC}" -n services-dev --timeout 90s
        else
          sed "s|ECR_REGISTRY_PLACEHOLDER|${REGISTRY}|g; s|CONTRACT_MCP_IRSA_ROLE_ARN_PLACEHOLDER|${CONTRACT_MCP_ROLE_ARN:-}|g" \
            "${REPO_ROOT}/services/${SVC}/helm-values-aws.yaml" \
            | helm upgrade --install "${SVC}" "${REPO_ROOT}/helm/service-template" \
                --namespace services-dev --create-namespace --values /dev/stdin --wait --timeout 3m
          helm_record_fingerprint "$_svc_fp_file" "$_svc_fp"
        fi
        check "${SVC} deployed → ALB"
      else
        # Try ArgoCD sync first; fall back to direct Helm install when the
        # ArgoCD application hasn't been registered yet (first-time install
        # before app-of-apps-local.yaml is applied). --plaintext is required:
        # the local ingress-nginx cert is self-signed and the CLI won't trust
        # it over --grpc-web alone, which previously made every call here
        # fail closed (see ARGOCD_SERVER/ARGOCD_AUTH_TOKEN setup above).
        _argocd_get_err=""
        if _argocd_get_err=$(argocd app get "${SVC}-local" --grpc-web --plaintext 2>&1 >/dev/null); then
          argocd app sync "${SVC}-local" --grpc-web --plaintext 2>/dev/null || true
          # `argocd app sync` can no-op or fail silently (see comment above on
          # false negatives); the app's own Automated+selfHeal policy will
          # still converge it independently. Either way the Deployment object
          # may not exist the instant sync returns — poll for it so the
          # `kubectl rollout status` below doesn't hit a race-y NotFound.
          for _i in $(seq 1 18); do
            kubectl get deployment "${SVC}" -n services-dev &>/dev/null && break
            sleep 5
          done
        elif kubectl get deployment "${SVC}" -n services-dev \
               -o jsonpath='{.metadata.annotations.argocd\.argoproj\.io/tracking-id}' 2>/dev/null | grep -q .; then
          # Defense in depth: `argocd app get` can false-negative (CLI auth
          # hiccup, transient connectivity) even when the app genuinely
          # exists. Don't blindly fight ArgoCD for ownership of resources it
          # already tracks — that's what produced the original symptom here
          # (a failed `helm install` unable to adopt an ArgoCD-owned
          # PodDisruptionBudget missing meta.helm.sh/* annotations).
          warn "${SVC}-local: 'argocd app get' failed (${_argocd_get_err:-no output}) but ${SVC}'s Deployment already carries an ArgoCD tracking-id — skipping direct Helm install to avoid an ownership conflict. Investigate: argocd app get ${SVC}-local --grpc-web --plaintext"
        else
          info "${SVC}-local ArgoCD app not found — deploying directly with Helm..."
          helm upgrade --install "${SVC}" "${REPO_ROOT}/helm/service-template" \
            --namespace services-dev --create-namespace \
            --values "${REPO_ROOT}/services/${SVC}/helm-values-local.yaml" \
            --wait --timeout 3m
        fi
        kubectl rollout status deployment/"${SVC}" -n services-dev --timeout 90s
        check "${SVC} deployed to services-dev"
      fi
    )
    # NOTE: deliberately not `(...) || warn ...` — wrapping a `set -e` subshell
    # directly in a `||`/`if` test disables `-e` for the *entire* subshell (a
    # well-known bash pitfall: bash sees the subshell's exit status is already
    # being checked by the caller, so it stops self-terminating on internal
    # command failures). That silently swallowed real docker/helm/kubectl
    # failures here before, letting `check "... deployed"` print a false
    # success. Capturing $? as its own statement keeps `-e` active inside.
    _svc_rc=$?
    if [[ $_svc_rc -ne 0 ]]; then
      warn "${SVC} build/deploy failed (exit ${_svc_rc}) — check: kubectl get po -n services-dev"
    fi
  done

  # ── 6b. Self-heal stuck RemoteMCPServers ────────────────────────────────────
  # Runs here, after the MCP servers are actually deployed. It used to run in
  # section 5, before section 6 had created the Deployments these
  # RemoteMCPServers point at — so it inspected servers that could not have
  # been healthy yet, and its retry path burned a 65s sleep on that premise.
  if [[ "$SKIP_KAGENT" != "true" ]]; then
    # Known kagent bug: the reconciler's tool-refresh transaction (DELETE + INSERT)
    # can fail with `duplicate key value violates unique constraint "tool_pkey"`
    # when the postgres `tool` table already has rows from a prior install (the
    # PVC survives helm uninstall). The RemoteMCPServer stays ACCEPTED=False and
    # its agents render with "No tools/agents available" in the UI even though
    # the Agent CRs report READY=True. Clearing the stale rows unblocks the next
    # reconcile tick (~60s).
    info "Self-healing RemoteMCPServers (clearing stale tool rows if reconciler is stuck)..."
    PG_POD=$(kubectl get pod -n kagent --no-headers 2>/dev/null | awk '/postgresql/{print $1;exit}')
    for attempt in 1 2 3; do
      stuck_servers=()
      while IFS= read -r srv; do
        [[ -z "$srv" ]] && continue
        msg=$(kubectl get remotemcpserver "$srv" -n kagent \
          -o jsonpath='{.status.conditions[?(@.type=="Accepted")].message}' 2>/dev/null || echo "")
        status=$(kubectl get remotemcpserver "$srv" -n kagent \
          -o jsonpath='{.status.conditions[?(@.type=="Accepted")].status}' 2>/dev/null || echo "")
        if [[ "$status" == "False" && "$msg" == *"duplicate key value violates unique constraint"* ]]; then
          stuck_servers+=("$srv")
        fi
      done < <(kubectl get remotemcpserver -n kagent -o name 2>/dev/null | sed 's|.*/||')

      if (( ${#stuck_servers[@]} == 0 )); then
        check "RemoteMCPServers reconciling cleanly"
        break
      fi

      if [[ -z "$PG_POD" ]]; then
        warn "kagent-postgresql pod not found — cannot self-heal stuck servers: ${stuck_servers[*]}"
        break
      fi

      for srv in "${stuck_servers[@]}"; do
        log "  Clearing stale tool rows for kagent/${srv} (attempt ${attempt}/3)..."
        kubectl exec -n kagent "$PG_POD" -- \
          psql -U kagent -d kagent -c \
          "DELETE FROM tool WHERE server_name = 'kagent/${srv}';" >/dev/null 2>&1 || \
          warn "  Failed to clear rows for ${srv}"
      done

      # Wait for the reconciler's next tick to repopulate.
      sleep 65
    done
  fi

  # Wire the HiTL approval gate into the tool servers whose mutating tools it
  # gates (argocd-mcp-server, github-mcp-server) and idp-mcp-server (which
  # exposes check_policy/request_approval/get_approval_status). Patched via
  # kubectl set env rather than baked into the default helm-values, so plain
  # `bootstrap-ai.sh` (no --adp) leaves these tools ungated exactly as before.
  if $ADP && [[ -d "${REPO_ROOT}/services/approval-service" ]] && kubectl get deployment approval-service -n services-dev &>/dev/null; then
    APPROVAL_URL="http://approval-service.services-dev.svc.cluster.local:3009"
    for _svc in idp-mcp-server argocd-mcp-server github-mcp-server; do
      if kubectl get deployment "$_svc" -n services-dev &>/dev/null; then
        kubectl set env deployment/"$_svc" -n services-dev APPROVAL_SERVICE_URL="$APPROVAL_URL" >/dev/null
      fi
    done
    check "APPROVAL_SERVICE_URL wired into idp/argocd/github-mcp-server"
  fi
fi

timer_end "6b. Deploy MCP servers"

# ── 7. KAgent UI port-forward (background) ───────────────────────────────────
# Provides direct access at http://localhost:8082 alongside the ingress hostname.
# Kills any stale port-forward first, then starts a fresh background one.

if [[ "$SKIP_KAGENT" == "false" && "$DEPLOY_MODE" == "local" ]]; then
  pkill -f "port-forward.*kagent-ui" 2>/dev/null || true
  sleep 1
  kubectl port-forward -n kagent svc/kagent-ui 8082:8080 \
    --address 127.0.0.1 >/dev/null 2>&1 &
  echo $! > /tmp/kagent-ui-pf.pid
  check "KAgent UI port-forward → http://localhost:8082 (PID $(cat /tmp/kagent-ui-pf.pid))"
fi

# ── Done ──────────────────────────────────────────────────────────────────────

_alb_ai() {
  kubectl get ingress "$1" -n "$2" \
    -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null \
    | grep -v '^$' || echo "pending..."
}

echo ""
echo "╔═══════════════════════════════════════════════════════════════════════════╗"
echo "║               AI/ML Platform Bootstrap Complete                          ║"
echo "╠═══════════════════════════════════════════════════════════════════════════╣"
if [[ "$DEPLOY_MODE" == "aws" ]]; then
  [[ "$SKIP_KAGENT"  == "false" ]] && echo "║  KAgent UI           http://$(_alb_ai kagent-ui kagent)"
  [[ "$SKIP_KAGENT"  == "false" ]] && echo "║  IDP Assistant (A2A) http://$(_alb_ai idp-assistant kagent)"
  [[ "$SKIP_MLFLOW"  == "false" ]] && echo "║  MLflow              http://$(_alb_ai mlflow ml-platform)"
  [[ "$SKIP_MCP"     == "false" ]] && echo "║  IDP MCP Server      http://$(_alb_ai idp-mcp-server services-dev)"
  [[ "$SKIP_MCP"     == "false" ]] && echo "║  QA MCP Server       http://$(_alb_ai qa-mcp-server services-dev)"
  [[ "$SKIP_MCP"     == "false" ]] && echo "║  Contract MCP Server http://$(_alb_ai contract-mcp-server services-dev)"
  [[ "$SKIP_MCP"     == "false" ]] && echo "║  GitHub MCP Server   http://$(_alb_ai github-mcp-server services-dev)"
  [[ "$SKIP_MCP"     == "false" ]] && echo "║  ArgoCD MCP Server   http://$(_alb_ai argocd-mcp-server services-dev)"
  [[ "$SKIP_MCP"     == "false" ]] && echo "║  Cost MCP Server     http://$(_alb_ai cost-mcp-server services-dev)"
else
  [[ "$SKIP_KAGENT"  == "false" ]] && echo "║  KAgent UI           http://kagent.idp.local"
  [[ "$SKIP_KAGENT"  == "false" ]] && echo "║  AI Assistant        http://backstage.idp.local/ai-assistant"
  [[ "$SKIP_MLFLOW"  == "false" ]] && echo "║  MLflow              http://mlflow.idp.local"
  [[ "$SKIP_MCP"     == "false" ]] && echo "║  IDP MCP Server      http://idp-mcp-server.idp.local/healthz"
  [[ "$SKIP_MCP"     == "false" ]] && echo "║  QA MCP Server       http://qa-mcp-server.idp.local/healthz"
  [[ "$SKIP_MCP"     == "false" ]] && echo "║  Contract MCP Server http://contract-mcp-server.idp.local/healthz"
  [[ "$SKIP_MCP"     == "false" ]] && echo "║  Event Router        http://agent-event-router.idp.local/healthz"
  [[ "$SKIP_MCP"     == "false" ]] && echo "║  GitHub MCP Server   http://github-mcp-server.idp.local/healthz"
  [[ "$SKIP_MCP"     == "false" ]] && echo "║  ArgoCD MCP Server   http://argocd-mcp-server.idp.local/healthz"
  [[ "$SKIP_MCP"     == "false" ]] && echo "║  Cost MCP Server     http://cost-mcp-server.idp.local/healthz"
fi
echo "╠═══════════════════════════════════════════════════════════════════════════╣"
echo "║  Model            Claude Haiku (claude-haiku-4-5-20251001)               ║"
if [[ "$DEPLOY_MODE" == "local" ]]; then
echo "║  All platform URLs: ./scripts/bootstrap-local.sh --print-urls            ║"
fi
echo "╚═══════════════════════════════════════════════════════════════════════════╝"
echo ""
if [[ "$SKIP_MCP" == "false" && "$DEPLOY_MODE" == "local" ]]; then
  echo "  Register CI runners for MCP servers (optional):"
  echo "    ./scripts/setup-runner.sh --repo idp-mcp-server"
  echo "    ./scripts/setup-runner.sh --repo qa-mcp-server"
  echo "    ./scripts/setup-runner.sh --repo contract-mcp-server"
  echo ""
fi
