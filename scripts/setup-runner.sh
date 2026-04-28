#!/usr/bin/env bash
# setup-runner.sh — register and start a GitHub Actions self-hosted runner
# for a scaffolded service repo so pushes auto-deploy to the local Kind cluster.
#
# Usage:
#   ./scripts/setup-runner.sh --repo <repo-name>
#   ./scripts/setup-runner.sh --repo fastspi-demo
#
# Requirements: gh CLI authenticated, Docker, kubectl, helm in PATH.
# Runner installs under ~/actions-runners/<repo-name>/

set -euo pipefail

RUNNERS_BASE="${HOME}/actions-runners"
RUNNER_VERSION=""

# Resolve the IDP platform root now, before any cd changes the working dir
IDP_PLATFORM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Source local/.env so GITHUB_ORG set by setup.sh is available
[[ -f "${IDP_PLATFORM_DIR}/local/.env" ]] && \
  set -o allexport && source "${IDP_PLATFORM_DIR}/local/.env" && set +o allexport || true

GITHUB_OWNER="${GITHUB_ORG:-YOUR_GITHUB_ORG}"

# ── parse args ────────────────────────────────────────────────────────────────
REPO_NAME=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --repo) REPO_NAME="$2"; shift 2 ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

if [[ -z "$REPO_NAME" ]]; then
  echo "Usage: $0 --repo <repo-name>"
  exit 1
fi

RUNNER_DIR="${RUNNERS_BASE}/${REPO_NAME}"

# ── already running? ──────────────────────────────────────────────────────────
if [[ -f "${RUNNER_DIR}/.runner" ]]; then
  PID_FILE="${RUNNER_DIR}/runner.pid"
  if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "Runner for ${REPO_NAME} is already running (PID $(cat "$PID_FILE"))"
    exit 0
  fi
  echo "Runner configured but not running — starting it..."
  cd "${RUNNER_DIR}"
  nohup ./run.sh > runner.log 2>&1 &
  echo $! > runner.pid
  echo "Runner started (PID $!)"
  exit 0
fi

# ── detect latest runner version ─────────────────────────────────────────────
echo "Fetching latest runner version..."
RUNNER_VERSION=$(curl -sf https://api.github.com/repos/actions/runner/releases/latest \
  | grep '"tag_name"' | sed 's/.*"v\([^"]*\)".*/\1/')
echo "Runner version: ${RUNNER_VERSION}"

# ── download runner binary ────────────────────────────────────────────────────
ARCH=$(uname -m)
if [[ "$ARCH" == "arm64" ]]; then
  RUNNER_ARCH="osx-arm64"
else
  RUNNER_ARCH="osx-x64"
fi

TARBALL="actions-runner-${RUNNER_ARCH}-${RUNNER_VERSION}.tar.gz"
DOWNLOAD_URL="https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${TARBALL}"

mkdir -p "${RUNNER_DIR}"
cd "${RUNNER_DIR}"

if [[ ! -f "${TARBALL}" ]]; then
  echo "Downloading runner from ${DOWNLOAD_URL}..."
  curl -fsSL -o "${TARBALL}" "${DOWNLOAD_URL}"
fi

echo "Extracting runner..."
tar xzf "${TARBALL}"

# ── get registration token ────────────────────────────────────────────────────
echo "Getting registration token for ${GITHUB_OWNER}/${REPO_NAME}..."
REG_TOKEN=$(gh api \
  "repos/${GITHUB_OWNER}/${REPO_NAME}/actions/runners/registration-token" \
  --method POST \
  --jq '.token')

# ── configure runner ──────────────────────────────────────────────────────────
echo "Configuring runner..."
./config.sh \
  --url "https://github.com/${GITHUB_OWNER}/${REPO_NAME}" \
  --token "${REG_TOKEN}" \
  --name "idp-local-${REPO_NAME}" \
  --labels "self-hosted,idp-local,macos" \
  --work "_work" \
  --unattended

# ── write platform dir into runner environment ────────────────────────────────
echo "IDP_PLATFORM_DIR=${IDP_PLATFORM_DIR}" >> "${RUNNER_DIR}/.env"
echo "Platform dir set: IDP_PLATFORM_DIR=${IDP_PLATFORM_DIR}"

# ── start runner in background ────────────────────────────────────────────────
echo "Starting runner..."
nohup ./run.sh > runner.log 2>&1 &
echo $! > runner.pid

echo ""
echo "✓ Runner 'idp-local-${REPO_NAME}' started (PID $!)"
echo "  Repo:    https://github.com/${GITHUB_OWNER}/${REPO_NAME}"
echo "  Logs:    ${RUNNER_DIR}/runner.log"
echo "  Stop:    kill \$(cat ${RUNNER_DIR}/runner.pid)"
