#!/usr/bin/env bash
# DEPRECATED: Use the idp CLI instead.
#   make cli-build          # build ./bin/idp
#   ./bin/idp scaffold service --name my-service --type nodejs
#
# This script is kept as a fallback reference only.
# create-service.sh — CLI golden path for scaffolding a new service
# Usage: ./scripts/create-service.sh --name my-service --type nodejs
set -euo pipefail

SERVICE_NAME=""
SERVICE_TYPE="nodejs"
NAMESPACE="services"

# Source local/.env so GITHUB_ORG and PLATFORM_REPO set by setup.sh are available
_ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
[[ -f "${_ROOT_DIR}/local/.env" ]] && \
  set -o allexport && source "${_ROOT_DIR}/local/.env" && set +o allexport || true

GH_ORG="${GH_ORG:-${GITHUB_ORG:-YOUR_GITHUB_ORG}}"
PLATFORM_REPO="${PLATFORM_REPO:-backstage-idp-starter}"

log() { echo "[$(date +%T)] $*"; }
err() { echo "[$(date +%T)] ERROR $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)      SERVICE_NAME="$2"; shift 2 ;;
    --type)      SERVICE_TYPE="$2"; shift 2 ;;
    --namespace) NAMESPACE="$2"; shift 2 ;;
    --org)       GH_ORG="$2"; shift 2 ;;
    *) err "Unknown flag: $1" ;;
  esac
done

[[ -z "$SERVICE_NAME" ]] && err "--name is required"
[[ "$SERVICE_NAME" =~ ^[a-z][a-z0-9-]*$ ]] || err "Service name must be lowercase alphanumeric with hyphens"

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TARGET_DIR="${ROOT_DIR}/services/${SERVICE_NAME}"

[[ -d "$TARGET_DIR" ]] && err "Service '${SERVICE_NAME}' already exists at ${TARGET_DIR}"

log "Scaffolding '${SERVICE_NAME}' (${SERVICE_TYPE})..."
mkdir -p "${TARGET_DIR}/src" "${TARGET_DIR}/k8s"

case "$SERVICE_TYPE" in
  nodejs)
    cat > "${TARGET_DIR}/package.json" <<EOF
{
  "name": "${SERVICE_NAME}",
  "version": "1.0.0",
  "main": "src/index.js",
  "scripts": {
    "start": "node src/index.js",
    "test": "jest"
  },
  "dependencies": {
    "express": "^4.18.2"
  },
  "devDependencies": {
    "jest": "^29.0.0",
    "supertest": "^6.3.0"
  }
}
EOF
    cat > "${TARGET_DIR}/src/index.js" <<EOF
const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => res.json({ service: '${SERVICE_NAME}', status: 'ok' }));
app.get('/healthz', (req, res) => res.json({ status: 'ok' }));
app.get('/ready', (req, res) => res.json({ status: 'ready' }));

app.listen(port, () => console.log(JSON.stringify({ msg: 'listening', port })));
EOF
    cat > "${TARGET_DIR}/README.md" <<EOF
# ${SERVICE_NAME}

Auto-scaffolded Node.js/Express service.

## Getting Started

\`\`\`bash
npm install
npm start
\`\`\`

## Endpoints

| Endpoint | Description |
|----------|-------------|
| \`GET /\` | Root — returns service name and status |
| \`GET /healthz\` | Liveness probe |
| \`GET /ready\` | Readiness probe |

## Running Tests

\`\`\`bash
npm test
\`\`\`

## Local Development (Kind)

\`\`\`bash
tilt up
# http://${SERVICE_NAME}.idp.local
\`\`\`

## Deploying

Push to \`main\` to trigger CI/CD (GitHub Actions → ECR → Helm deploy).

\`\`\`bash
# Manual Helm deploy (local)
helm upgrade --install ${SERVICE_NAME} ./helm/service-template \\
  --namespace ${NAMESPACE} \\
  --set image.repository=localhost:5001/${SERVICE_NAME} \\
  --set image.tag=latest \\
  --values services/${SERVICE_NAME}/helm-values-local.yaml

# Manual Helm deploy (AWS)
helm upgrade --install ${SERVICE_NAME} ./helm/service-template \\
  --namespace ${NAMESPACE} \\
  --set image.repository=<ECR_URI>/${SERVICE_NAME} \\
  --set image.tag=<git-sha> \\
  --values services/${SERVICE_NAME}/helm-values.yaml
\`\`\`
EOF
    ;;
  python)
    cat > "${TARGET_DIR}/requirements.txt" <<EOF
fastapi==0.110.0
uvicorn[standard]==0.29.0
EOF
    cat > "${TARGET_DIR}/src/main.py" <<EOF
from fastapi import FastAPI

app = FastAPI(title="${SERVICE_NAME}")

@app.get("/")
def root():
    return {"service": "${SERVICE_NAME}", "status": "ok"}

@app.get("/healthz")
def healthz():
    return {"status": "ok"}

@app.get("/ready")
def ready():
    return {"status": "ready"}
EOF
    cat > "${TARGET_DIR}/README.md" <<EOF
# ${SERVICE_NAME}

Auto-scaffolded Python/FastAPI service.

## Getting Started

\`\`\`bash
pip install -r requirements.txt
uvicorn src.main:app --host 0.0.0.0 --port 8000 --reload
\`\`\`

## Endpoints

| Endpoint | Description |
|----------|-------------|
| \`GET /\` | Root — returns service name and status |
| \`GET /healthz\` | Liveness probe |
| \`GET /ready\` | Readiness probe |
| \`GET /docs\` | Swagger UI |
| \`GET /openapi.json\` | OpenAPI schema |

## Local Development (Kind)

\`\`\`bash
tilt up
# http://${SERVICE_NAME}.idp.local
\`\`\`

## Deploying

Push to \`main\` to trigger CI/CD (GitHub Actions → ECR → Helm deploy).

\`\`\`bash
# Manual Helm deploy (local)
helm upgrade --install ${SERVICE_NAME} ./helm/service-template \\
  --namespace ${NAMESPACE} \\
  --set image.repository=localhost:5001/${SERVICE_NAME} \\
  --set image.tag=latest \\
  --values services/${SERVICE_NAME}/helm-values-local.yaml

# Manual Helm deploy (AWS)
helm upgrade --install ${SERVICE_NAME} ./helm/service-template \\
  --namespace ${NAMESPACE} \\
  --set image.repository=<ECR_URI>/${SERVICE_NAME} \\
  --set image.tag=<git-sha> \\
  --values services/${SERVICE_NAME}/helm-values.yaml
\`\`\`
EOF
    ;;
  go)
    cp -r "${ROOT_DIR}/services/hello-service/src/" "${TARGET_DIR}/src/"
    sed "s/hello-service/${SERVICE_NAME}/g" \
      "${ROOT_DIR}/services/hello-service/go.mod" > "${TARGET_DIR}/go.mod"
    ;;
  *) err "Unknown service type '${SERVICE_TYPE}'. Supported: nodejs, python, go" ;;
esac

# Dockerfile — type-specific
case "$SERVICE_TYPE" in
  nodejs)
    cat > "${TARGET_DIR}/Dockerfile" <<EOF
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY src/ ./src/

FROM gcr.io/distroless/nodejs20-debian12:nonroot
WORKDIR /app
COPY --from=builder /app .
EXPOSE 3000
CMD ["src/index.js"]
EOF
    ;;
  python)
    cat > "${TARGET_DIR}/Dockerfile" <<EOF
FROM python:3.12-slim AS builder
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir --user -r requirements.txt

FROM gcr.io/distroless/python3-debian12:nonroot
WORKDIR /app
COPY --from=builder /root/.local /root/.local
COPY src/ ./src/
ENV PATH=/root/.local/bin:\$PATH
EXPOSE 8000
CMD ["src/main.py"]
EOF
    ;;
  go)
    cat > "${TARGET_DIR}/Dockerfile" <<EOF
FROM golang:1.26-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY src/ ./src/
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /service ./src/...

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=builder /service /service
EXPOSE 8080
ENTRYPOINT ["/service"]
EOF
    ;;
esac

# GitHub Actions CI workflow
mkdir -p "${TARGET_DIR}/.github/workflows"

# Determine port and build/test commands per type
case "$SERVICE_TYPE" in
  nodejs) SVC_PORT=3000; TEST_CMD="npm test"; BUILD_SMOKE="docker build -t \${SERVICE_NAME}:ci ." ;;
  python) SVC_PORT=8000; TEST_CMD="pip install -r requirements.txt && pytest src/ -q"; BUILD_SMOKE="docker build -t \${SERVICE_NAME}:ci ." ;;
  go)     SVC_PORT=8080; TEST_CMD="go test ./src/... -coverprofile=coverage.out -covermode=atomic"; BUILD_SMOKE="docker build -t \${SERVICE_NAME}:ci ." ;;
esac

cat > "${TARGET_DIR}/.github/workflows/ci.yml" <<EOF
name: CI

on:
  push:
    branches: ['**']
  pull_request:
    branches: ['**']

permissions:
  contents: read

env:
  SERVICE_NAME: ${SERVICE_NAME}
  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: 'true'

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run tests
        run: ${TEST_CMD}
      - name: Build Docker image (smoke check)
        run: docker build -t ${SERVICE_NAME}:ci .
      - name: Smoke-test container
        run: |
          docker run -d --name svc -p ${SVC_PORT}:${SVC_PORT} -e PORT=${SVC_PORT} ${SERVICE_NAME}:ci
          sleep 3
          curl -sf --retry 5 --retry-delay 2 --retry-connrefused http://localhost:${SVC_PORT}/healthz
          docker stop svc && docker rm svc

  publish:
    needs: test
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    runs-on: ubuntu-latest
    permissions:
      contents: write
      packages: write
    steps:
      - uses: actions/checkout@v4
      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: \${{ github.actor }}
          password: \${{ secrets.GITHUB_TOKEN }}
      - name: Build and push image
        id: build
        run: |
          SHORT_SHA=\$(git rev-parse --short HEAD)
          IMAGE=ghcr.io/${GH_ORG}/${SERVICE_NAME}
          docker build -t \${IMAGE}:\${SHORT_SHA} -t \${IMAGE}:latest .
          docker push \${IMAGE}:\${SHORT_SHA}
          docker push \${IMAGE}:latest
          echo "SHORT_SHA=\${SHORT_SHA}" >> "\$GITHUB_ENV"
      - name: Update image tag in platform repo
        env:
          GH_TOKEN: \${{ secrets.GH_PAT }}
        run: |
          if [ -z "\$GH_TOKEN" ]; then
            echo "GH_PAT not set — platform repo image tag update skipped"
            exit 1
          fi
          git config --global user.email "ci@idp.platform"
          git config --global user.name "IDP CI Bot"
          git clone https://x-access-token:\${GH_TOKEN}@github.com/${GH_ORG}/${PLATFORM_REPO}.git /tmp/platform
          cd /tmp/platform
          VALUES_FILE="services/${SERVICE_NAME}/helm-values-dev.yaml"
          if [ -f "\${VALUES_FILE}" ]; then
            sed -i "s|^  tag: .*|  tag: \\"\${SHORT_SHA}\\"|" "\${VALUES_FILE}"
            git add "\${VALUES_FILE}"
            git diff --cached --quiet || git commit -m "chore: bump ${SERVICE_NAME} image to \${SHORT_SHA} [skip ci]"
            git push
          else
            echo "Values file not found — merge the Platform GitOps PR first"
          fi
EOF

# Helm values
cat > "${TARGET_DIR}/helm-values.yaml" <<EOF
replicaCount: 2
service:
  port: 80
  targetPort: 3000
ingress:
  enabled: true
  className: alb
  annotations:
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/target-type: ip
  hosts:
    - host: ""
      paths:
        - path: /
          pathType: Prefix
podSecurityContext:
  runAsNonRoot: true
  runAsUser: 1000
  seccompProfile:
    type: RuntimeDefault
securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities:
    drop: ["ALL"]
EOF

# Local helm values (nginx ingress, local registry)
cat > "${TARGET_DIR}/helm-values-local.yaml" <<EOF
replicaCount: 1
service:
  port: 80
  targetPort: 3000
ingress:
  enabled: true
  className: nginx
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
  hosts:
    - host: ${SERVICE_NAME}.idp.local
      paths:
        - path: /
          pathType: Prefix
resources:
  requests:
    cpu: 50m
    memory: 32Mi
  limits:
    cpu: 200m
    memory: 128Mi
podSecurityContext:
  runAsNonRoot: true
  runAsUser: 1000
  seccompProfile:
    type: RuntimeDefault
securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities:
    drop: ["ALL"]
EOF

# Dev helm values (GHCR image, nginx ingress)
cat > "${TARGET_DIR}/helm-values-dev.yaml" <<EOF
replicaCount: 1

image:
  repository: ghcr.io/${GH_ORG}/${SERVICE_NAME}
  tag: "latest"
  pullPolicy: IfNotPresent

service:
  port: 80
  targetPort: 3000

ingress:
  enabled: true
  className: "nginx"
  hosts:
    - host: ${SERVICE_NAME}-dev.idp.local
      paths:
        - path: /
          pathType: Prefix

resources:
  requests:
    cpu: 25m
    memory: 32Mi
  limits:
    cpu: 100m
    memory: 64Mi

env:
  - name: ENVIRONMENT
    value: dev
EOF

# Staging helm values (GHCR image, nginx ingress)
cat > "${TARGET_DIR}/helm-values-staging.yaml" <<EOF
replicaCount: 2

image:
  repository: ghcr.io/${GH_ORG}/${SERVICE_NAME}
  tag: "latest"
  pullPolicy: IfNotPresent

service:
  port: 80
  targetPort: 3000

ingress:
  enabled: true
  className: "nginx"
  hosts:
    - host: ${SERVICE_NAME}-staging.idp.local
      paths:
        - path: /
          pathType: Prefix

resources:
  requests:
    cpu: 50m
    memory: 64Mi
  limits:
    cpu: 200m
    memory: 128Mi

env:
  - name: ENVIRONMENT
    value: staging
EOF

# catalog-info.yaml for Backstage
cat > "${TARGET_DIR}/catalog-info.yaml" <<EOF
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: ${SERVICE_NAME}
  description: Auto-scaffolded service
  annotations:
    github.com/project-slug: ${GH_ORG}/${SERVICE_NAME}
    backstage.io/techdocs-ref: dir:.
    backstage.io/kubernetes-label-selector: app.kubernetes.io/instance=${SERVICE_NAME}
    backstage.io/kubernetes-namespace: ${NAMESPACE}
    backstage.io/adr-location: https://github.com/${GH_ORG}/${SERVICE_NAME}/tree/main/docs/adr
spec:
  type: service
  lifecycle: development
  owner: platform-team
  system: internal-developer-platform
EOF

log "Service '${SERVICE_NAME}' scaffolded at ${TARGET_DIR}"

# Commit platform repo values so ArgoCD ApplicationSet auto-discovers the service
cd "${ROOT_DIR}"
if git rev-parse --is-inside-work-tree &>/dev/null 2>&1; then
  git add "services/${SERVICE_NAME}/"
  git diff --cached --quiet || {
    git commit -m "feat: onboard ${SERVICE_NAME} to GitOps"
    log "Committed services/${SERVICE_NAME}/ to platform repo."
    if git push 2>/dev/null; then
      log "Pushed to remote. ArgoCD will auto-discover ${SERVICE_NAME} shortly."
    else
      log "Push failed (no remote or auth) — run: git push"
    fi
  }
fi

# Register GitHub Actions self-hosted runner so CI/CD auto-deploys on push
RUNNER_SCRIPT="${ROOT_DIR}/scripts/setup-runner.sh"
if command -v gh &>/dev/null && gh auth status &>/dev/null 2>&1; then
  # Only register if the repo exists on GitHub
  if gh repo view "${GH_ORG}/${SERVICE_NAME}" &>/dev/null 2>&1; then
    log "Registering self-hosted runner for ${SERVICE_NAME}..."
    bash "${RUNNER_SCRIPT}" --repo "${SERVICE_NAME}" && \
      log "Runner registered — pushes to main will auto-deploy to Kind." || \
      log "Runner setup failed — run: ./scripts/setup-runner.sh --repo ${SERVICE_NAME}"
  else
    log "Repo not on GitHub yet — after pushing, run: ./scripts/setup-runner.sh --repo ${SERVICE_NAME}"
  fi
fi

log ""
log "Next steps (local):"
log "  tilt up                          # hot-reload dev loop"
log "  git push origin main             # triggers CI/CD → auto-deploys to Kind"
log "  http://${SERVICE_NAME}.idp.local # service endpoint (add to /etc/hosts)"
log ""
log "Next steps (AWS):"
log "  Set AWS_ROLE_ARN secret in the GitHub repo, then push."
