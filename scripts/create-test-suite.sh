#!/usr/bin/env bash
# DEPRECATED: Use the idp CLI instead.
#   make cli-build          # build ./bin/idp
#   ./bin/idp scaffold test-suite --name my-e2e --type playwright --service hello-service
#
# This script is kept as a fallback reference only.
# create-test-suite.sh — CLI golden path for scaffolding QA test suites
#
# Usage:
#   ./scripts/create-test-suite.sh --name my-e2e       --type playwright   --service hello-service
#   ./scripts/create-test-suite.sh --name perf-tests   --type k6           --service hello-service --vus 20 --duration 1m
#   ./scripts/create-test-suite.sh --name a11y-checks  --type accessibility --service hello-service --wcag wcag2aa
#   ./scripts/create-test-suite.sh --name api-tests    --type newman        --service hello-service --base-url http://localhost:8080
#   ./scripts/create-test-suite.sh --name sec-scan     --type zap           --service hello-service --scan-type baseline
#   ./scripts/create-test-suite.sh --name contracts    --type pact          --service hello-service --consumer my-app --provider hello-service
#   ./scripts/create-test-suite.sh --name synthetics   --type datadog       --service hello-service --dd-site datadoghq.eu
#   ./scripts/create-test-suite.sh --name visual-snap  --type visual        --service hello-service --threshold 0.2
#   ./scripts/create-test-suite.sh --name bdd-suite    --type cucumber      --service hello-service
#   ./scripts/create-test-suite.sh --name mobile-tests --type appium        --service hello-service --platform android
#   ./scripts/create-test-suite.sh --name chaos-suite  --type chaos         --service hello-service --namespace services
#   ./scripts/create-test-suite.sh --name mut-tests    --type mutation      --service hello-service --score 70
#   ./scripts/create-test-suite.sh --name int-tests    --type testcontainers --service hello-service --containers postgres,redis
#
# Environment flag (sets sensible URL defaults for the target cluster):
#   --env local   Base URL → http://localhost:3000, Target URL → http://localhost:8080 (default)
#   --env aws     Base URL → https://<service>.example.com (placeholder), prompts to override with --base-url / --target-url
#
# Supported types:
#   playwright | k6 | pact | newman | zap | datadog | visual | accessibility | cucumber | appium | chaos | mutation | testcontainers

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
SUITE_NAME=""
SUITE_TYPE=""
TARGET_SERVICE=""
DEPLOY_ENV="local"

# Shared (overridden by --env or explicit --base-url / --target-url)
BASE_URL="http://localhost:3000"
TARGET_URL="http://localhost:8080"
_EXPLICIT_BASE_URL=false
_EXPLICIT_TARGET_URL=false

# k6
VUS=10
DURATION="30s"
P95_THRESHOLD=500

# pact
CONSUMER_NAME=""
PROVIDER_NAME=""
PACT_BROKER_URL="https://YOUR_ORG.pactflow.io"
PROVIDER_BASE_URL="http://localhost:8080"

# zap
SCAN_TYPE="baseline"
OPENAPI_URL="http://localhost:8080/openapi.json"
FAIL_RISK="High"

# datadog
DD_SITE="datadoghq.eu"

# visual
DIFF_THRESHOLD="0.2"

# accessibility
WCAG_LEVEL="wcag2aa"

# appium
PLATFORM="android"
APPIUM_SERVER="http://localhost:4723"

# chaos
NAMESPACE="services"
EXPERIMENTS="pod-failure,network-latency"
CHAOS_DURATION="1m"

# mutation / testcontainers
MUTATION_SCORE=70
TEST_RUNNER="jest"
CONTAINERS="postgres"

# ── Bootstrap ─────────────────────────────────────────────────────────────────
_ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
[[ -f "${_ROOT_DIR}/local/.env" ]] && \
  set -o allexport && source "${_ROOT_DIR}/local/.env" && set +o allexport || true

GH_ORG="${GH_ORG:-${GITHUB_ORG:-YOUR_GITHUB_ORG}}"

log() { echo "[$(date +%T)] $*"; }
err() { echo "[$(date +%T)] ERROR $*" >&2; exit 1; }

# ── Argument parsing ───────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)         SUITE_NAME="$2";         shift 2 ;;
    --type)         SUITE_TYPE="$2";         shift 2 ;;
    --service)      TARGET_SERVICE="$2";     shift 2 ;;
    --env)          DEPLOY_ENV="$2";         shift 2 ;;
    --base-url)     BASE_URL="$2"; _EXPLICIT_BASE_URL=true;     shift 2 ;;
    --target-url)   TARGET_URL="$2"; _EXPLICIT_TARGET_URL=true; shift 2 ;;
    --vus)          VUS="$2";                shift 2 ;;
    --duration)     DURATION="$2";           shift 2 ;;
    --p95)          P95_THRESHOLD="$2";      shift 2 ;;
    --consumer)     CONSUMER_NAME="$2";      shift 2 ;;
    --provider)     PROVIDER_NAME="$2";      shift 2 ;;
    --broker-url)   PACT_BROKER_URL="$2";    shift 2 ;;
    --scan-type)    SCAN_TYPE="$2";          shift 2 ;;
    --openapi-url)  OPENAPI_URL="$2";        shift 2 ;;
    --fail-risk)    FAIL_RISK="$2";          shift 2 ;;
    --dd-site)      DD_SITE="$2";            shift 2 ;;
    --threshold)    DIFF_THRESHOLD="$2";     shift 2 ;;
    --wcag)         WCAG_LEVEL="$2";         shift 2 ;;
    --platform)     PLATFORM="$2";           shift 2 ;;
    --appium-server) APPIUM_SERVER="$2";     shift 2 ;;
    --namespace)    NAMESPACE="$2";          shift 2 ;;
    --experiments)  EXPERIMENTS="$2";        shift 2 ;;
    --chaos-duration) CHAOS_DURATION="$2";   shift 2 ;;
    --score)        MUTATION_SCORE="$2";     shift 2 ;;
    --test-runner)  TEST_RUNNER="$2";        shift 2 ;;
    --containers)   CONTAINERS="$2";         shift 2 ;;
    --help|-h)
      sed -n '3,20p' "$0" | sed 's/^# //'
      exit 0 ;;
    *) err "Unknown flag: $1. Run with --help for usage." ;;
  esac
done

# ── Environment URL defaults ──────────────────────────────────────────────────
if [[ "$DEPLOY_ENV" == "aws" ]]; then
  [[ "$_EXPLICIT_BASE_URL" == false ]]   && BASE_URL="https://<alb-dns>.amazonaws.com"
  [[ "$_EXPLICIT_TARGET_URL" == false ]] && TARGET_URL="https://<alb-dns>.amazonaws.com"
  [[ "$_EXPLICIT_TARGET_URL" == false ]] && OPENAPI_URL="${TARGET_URL}/openapi.json"
  [[ "$_EXPLICIT_TARGET_URL" == false ]] && PROVIDER_BASE_URL="${TARGET_URL}"
  APPIUM_SERVER="http://<appium-grid-host>:4723"
  log "env=aws — BASE_URL=${BASE_URL}  (override with --base-url / --target-url)"
fi

# ── Validation ────────────────────────────────────────────────────────────────
[[ -z "$SUITE_NAME" ]]    && err "--name is required"
[[ -z "$SUITE_TYPE" ]]    && err "--type is required"
[[ -z "$TARGET_SERVICE" ]] && err "--service is required"

[[ "$SUITE_NAME" =~ ^[a-z][a-z0-9-]*[a-z0-9]$ ]] || \
  err "--name must be lowercase alphanumeric with hyphens (e.g. my-e2e-suite)"

VALID_TYPES="playwright k6 pact newman zap datadog visual accessibility cucumber appium chaos mutation testcontainers"
[[ " $VALID_TYPES " == *" $SUITE_TYPE "* ]] || \
  err "Unknown type '$SUITE_TYPE'. Supported: $VALID_TYPES"

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TARGET_DIR="${ROOT_DIR}/test-suites/${SUITE_NAME}"

[[ -d "$TARGET_DIR" ]] && err "Test suite '${SUITE_NAME}' already exists at ${TARGET_DIR}"

log "Scaffolding '${SUITE_NAME}' (${SUITE_TYPE}) → test-suites/${SUITE_NAME}/"
mkdir -p "${TARGET_DIR}"

# ── Helpers ───────────────────────────────────────────────────────────────────

write_catalog_info() {
  local tags="$1"
  cat > "${TARGET_DIR}/catalog-info.yaml" <<EOF
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: ${SUITE_NAME}
  description: ${SUITE_TYPE} test suite for ${TARGET_SERVICE}
  annotations:
    github.com/project-slug: ${GH_ORG}/${SUITE_NAME}
    backstage.io/techdocs-ref: dir:.
  tags:
$(echo "$tags" | tr ',' '\n' | sed 's/^/    - /')
spec:
  type: test-suite
  lifecycle: production
  owner: qa-team
  system: internal-developer-platform
  dependsOn:
    - component:default/${TARGET_SERVICE}
EOF
}

write_mkdocs() {
  cat > "${TARGET_DIR}/mkdocs.yml" <<EOF
site_name: ${SUITE_NAME}
site_description: ${SUITE_TYPE} test suite for ${TARGET_SERVICE}

nav:
  - Home: index.md

plugins:
  - techdocs-core
EOF
  mkdir -p "${TARGET_DIR}/docs"
}

write_node_package() {
  local extra_deps="$1"
  cat > "${TARGET_DIR}/package.json" <<EOF
{
  "name": "${SUITE_NAME}",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "test": "${2:-npm test}"
  },
  "devDependencies": {
${extra_deps}
  }
}
EOF
}

# ── Type-specific scaffold ────────────────────────────────────────────────────

scaffold_playwright() {
  write_mkdocs
  write_catalog_info "playwright,e2e,testing,qa"
  write_node_package \
    '    "@playwright/test": "^1.44.0",
    "typescript": "^5.4.0"' \
    "playwright test"

  cat > "${TARGET_DIR}/tsconfig.json" <<EOF
{ "compilerOptions": { "target": "ES2022", "module": "commonjs", "strict": true, "esModuleInterop": true, "skipLibCheck": true } }
EOF

  cat > "${TARGET_DIR}/playwright.config.ts" <<EOF
import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [['html', { open: 'never' }], ['github']],
  use: {
    baseURL: process.env.BASE_URL ?? '${BASE_URL}',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
EOF

  mkdir -p "${TARGET_DIR}/tests/fixtures"
  cat > "${TARGET_DIR}/tests/fixtures/base.fixture.ts" <<'EOF'
import { test as base, expect } from '@playwright/test';
export const test = base.extend({});
export { expect };
EOF

  cat > "${TARGET_DIR}/tests/example.spec.ts" <<EOF
import { test, expect } from './fixtures/base.fixture';

test.describe('${TARGET_SERVICE} smoke', () => {
  test('homepage loads', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/.+/);
  });

  test('health endpoint returns 200', async ({ request }) => {
    const res = await request.get('/healthz');
    expect(res.status()).toBe(200);
  });
});
EOF

  cat > "${TARGET_DIR}/README.md" <<EOF
# ${SUITE_NAME}

Playwright E2E suite for \`${TARGET_SERVICE}\`.

\`\`\`bash
npm install && npx playwright install --with-deps
npm test
npx playwright show-report
BASE_URL=http://staging.example.com npm test   # override target
\`\`\`
EOF

  cat > "${TARGET_DIR}/docs/index.md" <<EOF
# ${SUITE_NAME}

Playwright E2E suite targeting **${TARGET_SERVICE}** at \`${BASE_URL}\`.

Run \`npm test\` locally, or push to trigger GitHub Actions CI.
EOF
}

scaffold_k6() {
  write_mkdocs
  write_catalog_info "k6,performance,load-testing,qa"

  mkdir -p "${TARGET_DIR}/tests"

  cat > "${TARGET_DIR}/tests/smoke.js" <<EOF
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 1, duration: '30s',
  thresholds: { http_req_duration: ['p(95)<${P95_THRESHOLD}'], http_req_failed: ['rate<0.01'] },
};

const BASE = __ENV.TARGET_URL || '${TARGET_URL}';
export default function () {
  const r = http.get(\`\${BASE}/healthz\`);
  check(r, { 'status 200': (res) => res.status === 200 });
  sleep(1);
}
EOF

  cat > "${TARGET_DIR}/tests/load.js" <<EOF
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: ${VUS} },
    { duration: '${DURATION}', target: ${VUS} },
    { duration: '30s', target: 0 },
  ],
  thresholds: { http_req_duration: ['p(95)<${P95_THRESHOLD}'], http_req_failed: ['rate<0.01'] },
};

const BASE = __ENV.TARGET_URL || '${TARGET_URL}';
export default function () {
  const r = http.get(\`\${BASE}/\`);
  check(r, { 'status 2xx': (res) => res.status >= 200 && res.status < 300 });
  sleep(1);
}
EOF

  cat > "${TARGET_DIR}/tests/stress.js" <<EOF
import http from 'k6/http';
import { check, sleep } from 'k6';

const PEAK = ${VUS} * 3;
export const options = {
  stages: [
    { duration: '2m', target: ${VUS} }, { duration: '5m', target: ${VUS} },
    { duration: '2m', target: PEAK },   { duration: '5m', target: PEAK },
    { duration: '2m', target: 0 },
  ],
  thresholds: { http_req_duration: ['p(99)<2000'], http_req_failed: ['rate<0.05'] },
};

const BASE = __ENV.TARGET_URL || '${TARGET_URL}';
export default function () {
  check(http.get(\`\${BASE}/\`), { 'status 2xx': (r) => r.status >= 200 && r.status < 300 });
  sleep(1);
}
EOF

  cat > "${TARGET_DIR}/README.md" <<EOF
# ${SUITE_NAME}

k6 performance suite for \`${TARGET_SERVICE}\` — ${VUS} VUs, ${DURATION}, p95 < ${P95_THRESHOLD}ms.

\`\`\`bash
k6 run tests/smoke.js
k6 run tests/load.js
k6 run tests/stress.js
k6 run -e TARGET_URL=http://staging.example.com tests/load.js
\`\`\`
EOF

  cat > "${TARGET_DIR}/docs/index.md" <<EOF
# ${SUITE_NAME}

k6 performance suite for **${TARGET_SERVICE}**.

| Parameter | Value |
|-----------|-------|
| Target URL | \`${TARGET_URL}\` |
| Load VUs | ${VUS} |
| Duration | ${DURATION} |
| p95 threshold | ${P95_THRESHOLD}ms |
EOF
}

scaffold_pact() {
  [[ -z "$CONSUMER_NAME" ]] && CONSUMER_NAME="${SUITE_NAME}-consumer"
  [[ -z "$PROVIDER_NAME" ]] && PROVIDER_NAME="${TARGET_SERVICE}"

  write_mkdocs
  write_catalog_info "pact,contract-testing,testing,qa"
  write_node_package \
    '    "@pact-foundation/pact": "^12.0.0",
    "@types/jest": "^29.0.0",
    "jest": "^29.0.0",
    "ts-jest": "^29.0.0",
    "typescript": "^5.4.0"' \
    "jest --testPathPattern=consumer"

  mkdir -p "${TARGET_DIR}/tests"

  cat > "${TARGET_DIR}/tests/consumer.pact.spec.ts" <<EOF
import { PactV3, MatchersV3 } from '@pact-foundation/pact';
import * as path from 'path';

const { like } = MatchersV3;

const provider = new PactV3({
  consumer: '${CONSUMER_NAME}',
  provider: '${PROVIDER_NAME}',
  dir: path.resolve(process.cwd(), 'pacts'),
});

describe('${CONSUMER_NAME} → ${PROVIDER_NAME}', () => {
  it('health endpoint responds', async () => {
    await provider
      .given('provider is healthy')
      .uponReceiving('a health check')
      .withRequest({ method: 'GET', path: '/healthz' })
      .willRespondWith({ status: 200, body: like({ status: 'ok' }) })
      .executeTest(async (mock) => {
        const res = await fetch(\`\${mock.url}/healthz\`);
        expect(res.status).toBe(200);
      });
  });
});
EOF

  cat > "${TARGET_DIR}/README.md" <<EOF
# ${SUITE_NAME}

Pact contract tests: **${CONSUMER_NAME}** → **${PROVIDER_NAME}**.

\`\`\`bash
npm install
npm test                    # generate pacts/
PROVIDER_BASE_URL=${PROVIDER_BASE_URL} npm run verify
\`\`\`

Set \`PACT_BROKER_TOKEN\` secret to publish to \`${PACT_BROKER_URL}\`.
EOF

  cat > "${TARGET_DIR}/docs/index.md" <<EOF
# ${SUITE_NAME}

Pact consumer-driven contracts for **${TARGET_SERVICE}**.

| Parameter | Value |
|-----------|-------|
| Consumer | \`${CONSUMER_NAME}\` |
| Provider | \`${PROVIDER_NAME}\` |
| Broker | \`${PACT_BROKER_URL}\` |
EOF
}

scaffold_newman() {
  write_mkdocs
  write_catalog_info "newman,postman,api-testing,qa"
  write_node_package \
    '    "newman": "^6.1.0",
    "newman-reporter-htmlextra": "^1.23.0"' \
    "newman run collections/${SUITE_NAME}.postman_collection.json -e environments/dev.json --reporters cli,junit --reporter-junit-export reports/results.xml"

  mkdir -p "${TARGET_DIR}/collections" "${TARGET_DIR}/environments" "${TARGET_DIR}/reports"

  cat > "${TARGET_DIR}/environments/dev.json" <<EOF
{
  "name": "${SUITE_NAME}-dev",
  "values": [{ "key": "baseUrl", "value": "${BASE_URL}", "type": "default", "enabled": true }]
}
EOF

  cat > "${TARGET_DIR}/collections/${SUITE_NAME}.postman_collection.json" <<EOF
{
  "info": { "name": "${SUITE_NAME}", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
  "item": [{
    "name": "Health Check",
    "item": [
      {
        "name": "GET /healthz",
        "request": { "method": "GET", "url": "{{baseUrl}}/healthz" },
        "event": [{ "listen": "test", "script": { "exec": ["pm.test('Status 200', () => pm.response.to.have.status(200));"], "type": "text/javascript" } }]
      }
    ]
  }]
}
EOF

  cat > "${TARGET_DIR}/README.md" <<EOF
# ${SUITE_NAME}

Newman API test suite for \`${TARGET_SERVICE}\` at \`${BASE_URL}\`.

\`\`\`bash
npm install && npm test
\`\`\`

Import \`collections/${SUITE_NAME}.postman_collection.json\` into Postman to edit visually.
EOF

  cat > "${TARGET_DIR}/docs/index.md" <<EOF
# ${SUITE_NAME}

Newman API suite targeting **${TARGET_SERVICE}** at \`${BASE_URL}\`.
EOF
}

scaffold_zap() {
  write_mkdocs
  write_catalog_info "zap,dast,security,owasp,qa"

  mkdir -p "${TARGET_DIR}/.zap" "${TARGET_DIR}/reports"

  cat > "${TARGET_DIR}/.zap/rules.tsv" <<'EOF'
# ZAP false-positive suppression
# Format: <ruleId>\t<action>\t<url>\t<parameter>\t<attack>\t<evidence>\t<comment>
# Example: 10021\tIGNORE\t.*\t.*\t.*\t.*\tKnown false positive
EOF

  cat > "${TARGET_DIR}/README.md" <<EOF
# ${SUITE_NAME}

OWASP ZAP \`${SCAN_TYPE}\` DAST scan for \`${TARGET_SERVICE}\` at \`${TARGET_URL}\`.

\`\`\`bash
# Requires Docker
docker run --rm -v \$(pwd)/reports:/zap/wrk:rw \\
  ghcr.io/zaproxy/zaproxy:stable zap-${SCAN_TYPE}.py \\
  -t ${TARGET_URL} -r zap-report.html
\`\`\`

Suppress false positives in \`.zap/rules.tsv\`.
EOF

  cat > "${TARGET_DIR}/docs/index.md" <<EOF
# ${SUITE_NAME}

OWASP ZAP security scan for **${TARGET_SERVICE}**.

| Parameter | Value |
|-----------|-------|
| Scan type | \`${SCAN_TYPE}\` |
| Target URL | \`${TARGET_URL}\` |
| OpenAPI URL | \`${OPENAPI_URL}\` |
| Fail on | \`${FAIL_RISK}\` risk and above |
EOF
}

scaffold_datadog() {
  write_mkdocs
  write_catalog_info "datadog,synthetic,monitoring,qa"
  write_node_package \
    '    "@datadog/datadog-ci": "^2.18.0"' \
    "datadog-ci synthetics run-tests --config datadog-ci.json"

  mkdir -p "${TARGET_DIR}/synthetics"

  cat > "${TARGET_DIR}/datadog-ci.json" <<EOF
{
  "datadogSite": "${DD_SITE}",
  "files": ["synthetics/**/*.json"],
  "failOnCriticalErrors": true,
  "failOnMissingTests": true,
  "runName": "${SUITE_NAME} - CI run"
}
EOF

  cat > "${TARGET_DIR}/synthetics/api-test.json" <<EOF
{
  "name": "${SUITE_NAME} - API health check",
  "type": "api", "subtype": "http", "status": "live",
  "tags": ["service:${SUITE_NAME}", "env:production"],
  "locations": ["aws:eu-west-1", "aws:us-east-1"],
  "options": { "tick_every": 300, "retry": { "count": 2, "interval": 300 } },
  "config": {
    "request": { "method": "GET", "url": "${TARGET_URL}/healthz", "timeout": 30 },
    "assertions": [
      { "type": "statusCode", "operator": "is", "target": 200 },
      { "type": "responseTime", "operator": "lessThan", "target": 2000 }
    ]
  }
}
EOF

  cat > "${TARGET_DIR}/README.md" <<EOF
# ${SUITE_NAME}

Datadog synthetic tests for \`${TARGET_SERVICE}\` on \`${DD_SITE}\`.

\`\`\`bash
npm install
DD_API_KEY=<key> DD_APP_KEY=<app_key> npm test
\`\`\`

Set \`DD_API_KEY\` and \`DD_APP_KEY\` as GitHub repository secrets.
EOF

  cat > "${TARGET_DIR}/docs/index.md" <<EOF
# ${SUITE_NAME}

Datadog synthetic monitoring for **${TARGET_SERVICE}**.

| Parameter | Value |
|-----------|-------|
| Datadog site | \`${DD_SITE}\` |
| Target URL | \`${TARGET_URL}\` |
EOF
}

scaffold_visual() {
  write_mkdocs
  write_catalog_info "visual-regression,playwright,testing,qa"
  write_node_package \
    '    "@playwright/test": "^1.44.0",
    "typescript": "^5.4.0"' \
    "playwright test"

  mkdir -p "${TARGET_DIR}/tests"

  cat > "${TARGET_DIR}/playwright.config.ts" <<EOF
import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  reporter: [['html', { open: 'never' }]],
  use: {
    baseURL: process.env.BASE_URL ?? '${BASE_URL}',
    screenshot: 'on',
  },
  expect: { toHaveScreenshot: { maxDiffPixelRatio: ${DIFF_THRESHOLD} / 100 } },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
EOF

  cat > "${TARGET_DIR}/tests/visual.spec.ts" <<EOF
import { test, expect } from '@playwright/test';

test.describe('${TARGET_SERVICE} visual snapshots', () => {
  test('homepage matches snapshot', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveScreenshot('homepage.png', { fullPage: true });
  });
});
EOF

  cat > "${TARGET_DIR}/README.md" <<EOF
# ${SUITE_NAME}

Visual regression suite for \`${TARGET_SERVICE}\`. Diff threshold: **${DIFF_THRESHOLD}%**.

\`\`\`bash
npm install && npx playwright install chromium
npm run test:update   # capture baseline snapshots
npm test              # compare against baseline
\`\`\`

Commit \`tests/__snapshots__/\` as the golden baseline.
EOF

  cat > "${TARGET_DIR}/docs/index.md" <<EOF
# ${SUITE_NAME}

Visual regression suite for **${TARGET_SERVICE}** at \`${BASE_URL}\`.
Max pixel diff: **${DIFF_THRESHOLD}%**.
EOF

  # add update-snapshots script
  node -e "
const fs=require('fs');
const p=JSON.parse(fs.readFileSync('${TARGET_DIR}/package.json'));
p.scripts['test:update']='playwright test --update-snapshots';
fs.writeFileSync('${TARGET_DIR}/package.json', JSON.stringify(p,null,2)+'\n');
" 2>/dev/null || true
}

scaffold_accessibility() {
  write_mkdocs
  write_catalog_info "accessibility,a11y,axe-core,playwright,qa"
  write_node_package \
    '    "@axe-core/playwright": "^4.9.0",
    "@playwright/test": "^1.44.0",
    "typescript": "^5.4.0"' \
    "playwright test"

  mkdir -p "${TARGET_DIR}/tests"

  cat > "${TARGET_DIR}/playwright.config.ts" <<EOF
import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  reporter: [['html', { open: 'never' }], ['github']],
  use: { baseURL: process.env.BASE_URL ?? '${BASE_URL}' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
EOF

  cat > "${TARGET_DIR}/tests/a11y.spec.ts" <<EOF
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.describe('${TARGET_SERVICE} accessibility (${WCAG_LEVEL})', () => {
  test('homepage has no violations', async ({ page }) => {
    await page.goto('/');
    const results = await new AxeBuilder({ page })
      .withTags(['${WCAG_LEVEL}'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
EOF

  cat > "${TARGET_DIR}/README.md" <<EOF
# ${SUITE_NAME}

axe-core + Playwright accessibility suite for \`${TARGET_SERVICE}\`. Standard: **${WCAG_LEVEL}**.

\`\`\`bash
npm install && npx playwright install chromium --with-deps
npm test
\`\`\`
EOF

  cat > "${TARGET_DIR}/docs/index.md" <<EOF
# ${SUITE_NAME}

Accessibility suite for **${TARGET_SERVICE}** enforcing **${WCAG_LEVEL}** at \`${BASE_URL}\`.
EOF
}

scaffold_cucumber() {
  write_mkdocs
  write_catalog_info "bdd,cucumber,gherkin,testing,qa"
  write_node_package \
    '    "@cucumber/cucumber": "^10.8.0",
    "axios": "^1.7.0",
    "ts-node": "^10.9.0",
    "typescript": "^5.4.0"' \
    "cucumber-js --config cucumber.js"

  mkdir -p "${TARGET_DIR}/features" "${TARGET_DIR}/steps" "${TARGET_DIR}/reports"

  cat > "${TARGET_DIR}/cucumber.js" <<EOF
module.exports = {
  default: {
    require: ['steps/**/*.ts'],
    requireModule: ['ts-node/register'],
    format: ['progress-bar', 'junit:reports/junit.xml'],
    paths: ['features/**/*.feature'],
    publishQuiet: true,
  },
};
EOF

  cat > "${TARGET_DIR}/features/health.feature" <<EOF
Feature: ${TARGET_SERVICE} health

  Scenario: Liveness probe returns 200
    Given the service is running at "${BASE_URL}"
    When I request "/healthz"
    Then the response status should be 200

  Scenario: Readiness probe returns 200
    Given the service is running at "${BASE_URL}"
    When I request "/ready"
    Then the response status should be 200
EOF

  cat > "${TARGET_DIR}/steps/health.steps.ts" <<'EOF'
import { Given, When, Then } from '@cucumber/cucumber';
import axios from 'axios';
import assert from 'assert';

let baseUrl: string;
let response: { status: number };

Given('the service is running at {string}', (url: string) => {
  baseUrl = process.env.BASE_URL ?? url;
});

When('I request {string}', async (path: string) => {
  response = await axios.get(`${baseUrl}${path}`, { validateStatus: () => true });
});

Then('the response status should be {int}', (expected: number) => {
  assert.strictEqual(response.status, expected);
});
EOF

  cat > "${TARGET_DIR}/README.md" <<EOF
# ${SUITE_NAME}

Cucumber.js BDD suite for \`${TARGET_SERVICE}\`.

\`\`\`bash
npm install
npm test
BASE_URL=http://staging.example.com npm test
\`\`\`
EOF

  cat > "${TARGET_DIR}/docs/index.md" <<EOF
# ${SUITE_NAME}

Cucumber.js BDD suite for **${TARGET_SERVICE}** at \`${BASE_URL}\`.
Feature files are in \`features/\`, step definitions in \`steps/\`.
EOF
}

scaffold_appium() {
  write_mkdocs
  write_catalog_info "appium,mobile,testing,qa"
  write_node_package \
    '    "@wdio/cli": "^8.36.0",
    "@wdio/local-runner": "^8.36.0",
    "@wdio/mocha-framework": "^8.36.0",
    "@wdio/spec-reporter": "^8.36.0",
    "@wdio/junit-reporter": "^8.36.0",
    "appium": "^2.5.0",
    "appium-uiautomator2-driver": "^3.5.0",
    "ts-node": "^10.9.0",
    "typescript": "^5.4.0",
    "wait-on": "^7.2.0"' \
    "wdio run wdio.config.ts"

  mkdir -p "${TARGET_DIR}/tests" "${TARGET_DIR}/reports"

  local automation_name="UiAutomator2"
  local device_name="Android Emulator"
  local platform_name="Android"
  if [[ "$PLATFORM" == "ios" ]]; then
    automation_name="XCUITest"
    device_name="iPhone Simulator"
    platform_name="iOS"
  fi

  cat > "${TARGET_DIR}/wdio.config.ts" <<EOF
import type { Options } from '@wdio/types';
export const config: Options.Testrunner = {
  runner: 'local',
  specs: ['./tests/**/*.spec.ts'],
  framework: 'mocha',
  reporters: ['spec', ['junit', { outputDir: './reports' }]],
  mochaOpts: { timeout: 60000 },
  capabilities: [{
    platformName: '${platform_name}',
    'appium:automationName': '${automation_name}',
    'appium:deviceName': '${device_name}',
    'appium:app': process.env.APP_PATH ?? 'path/to/your.app',
  }],
  services: [['appium', { command: 'appium', args: { address: '127.0.0.1', port: 4723 } }]],
};
EOF

  cat > "${TARGET_DIR}/tests/app.spec.ts" <<EOF
import { browser } from '@wdio/globals';

describe('${TARGET_SERVICE} mobile smoke', () => {
  it('app launches', async () => {
    expect(await browser.getPageSource()).toBeTruthy();
  });
});
EOF

  cat > "${TARGET_DIR}/README.md" <<EOF
# ${SUITE_NAME}

Appium + WebdriverIO mobile tests for \`${TARGET_SERVICE}\` on **${PLATFORM}**.

\`\`\`bash
npm install
APP_PATH=/path/to/your.app npm test
\`\`\`
EOF

  cat > "${TARGET_DIR}/docs/index.md" <<EOF
# ${SUITE_NAME}

Appium mobile test suite for **${TARGET_SERVICE}** on **${PLATFORM}**.
Appium server: \`${APPIUM_SERVER}\`.
EOF
}

scaffold_chaos() {
  write_mkdocs
  write_catalog_info "chaos,chaos-mesh,resilience,testing,qa"

  mkdir -p "${TARGET_DIR}/experiments"

  cat > "${TARGET_DIR}/experiments/pod-failure.yaml" <<EOF
apiVersion: chaos-mesh.org/v1alpha1
kind: PodChaos
metadata:
  name: ${SUITE_NAME}-pod-failure
  namespace: ${NAMESPACE}
spec:
  action: pod-failure
  mode: one
  duration: '${CHAOS_DURATION}'
  selector:
    namespaces: [${NAMESPACE}]
    labelSelectors:
      app.kubernetes.io/name: ${TARGET_SERVICE}
EOF

  cat > "${TARGET_DIR}/experiments/network-latency.yaml" <<EOF
apiVersion: chaos-mesh.org/v1alpha1
kind: NetworkChaos
metadata:
  name: ${SUITE_NAME}-network-latency
  namespace: ${NAMESPACE}
spec:
  action: delay
  mode: all
  duration: '${CHAOS_DURATION}'
  selector:
    namespaces: [${NAMESPACE}]
    labelSelectors:
      app.kubernetes.io/name: ${TARGET_SERVICE}
  delay:
    latency: '100ms'
    jitter: '20ms'
    correlation: '25'
EOF

  cat > "${TARGET_DIR}/experiments/cpu-stress.yaml" <<EOF
apiVersion: chaos-mesh.org/v1alpha1
kind: StressChaos
metadata:
  name: ${SUITE_NAME}-cpu-stress
  namespace: ${NAMESPACE}
spec:
  mode: one
  duration: '${CHAOS_DURATION}'
  selector:
    namespaces: [${NAMESPACE}]
    labelSelectors:
      app.kubernetes.io/name: ${TARGET_SERVICE}
  stressors:
    cpu: { workers: 2, load: 80 }
EOF

  cat > "${TARGET_DIR}/experiments/memory-stress.yaml" <<EOF
apiVersion: chaos-mesh.org/v1alpha1
kind: StressChaos
metadata:
  name: ${SUITE_NAME}-memory-stress
  namespace: ${NAMESPACE}
spec:
  mode: one
  duration: '${CHAOS_DURATION}'
  selector:
    namespaces: [${NAMESPACE}]
    labelSelectors:
      app.kubernetes.io/name: ${TARGET_SERVICE}
  stressors:
    memory: { workers: 1, size: '256MB' }
EOF

  cat > "${TARGET_DIR}/README.md" <<EOF
# ${SUITE_NAME}

Chaos Mesh experiments for \`${TARGET_SERVICE}\` in namespace \`${NAMESPACE}\`. Duration: **${CHAOS_DURATION}**.

\`\`\`bash
kubectl apply -f experiments/pod-failure.yaml
# wait ${CHAOS_DURATION}, then:
kubectl delete -f experiments/pod-failure.yaml
\`\`\`
EOF

  cat > "${TARGET_DIR}/docs/index.md" <<EOF
# ${SUITE_NAME}

Chaos Mesh resilience experiments for **${TARGET_SERVICE}** in \`${NAMESPACE}\`.
Duration per experiment: **${CHAOS_DURATION}**.

| Experiment | Type |
|-----------|------|
| pod-failure | PodChaos |
| network-latency | NetworkChaos |
| cpu-stress | StressChaos |
| memory-stress | StressChaos |
EOF
}

scaffold_mutation() {
  write_mkdocs
  write_catalog_info "stryker,mutation-testing,testing,qa"
  write_node_package \
    "    \"@stryker-mutator/core\": \"^8.2.0\",
    \"@stryker-mutator/${TEST_RUNNER}-runner\": \"^8.2.0\",
    \"typescript\": \"^5.4.0\"" \
    "stryker run"

  local break_score=$(( MUTATION_SCORE - 20 ))

  cat > "${TARGET_DIR}/stryker.config.js" <<EOF
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
module.exports = {
  packageManager: 'npm',
  testRunner: '${TEST_RUNNER}',
  reporters: ['progress', 'html', 'json'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/report.json' },
  coverageAnalysis: 'perTest',
  thresholds: { high: ${MUTATION_SCORE}, low: $(( MUTATION_SCORE - 10 )), break: ${break_score} },
};
EOF

  mkdir -p "${TARGET_DIR}/reports/mutation"

  cat > "${TARGET_DIR}/README.md" <<EOF
# ${SUITE_NAME}

Stryker mutation testing for \`${TARGET_SERVICE}\`. Min score: **${MUTATION_SCORE}%**.

\`\`\`bash
npm install && npm test
# HTML report: reports/mutation/index.html
\`\`\`

Point \`stryker.config.js\` at the target service source and test files before running.
EOF

  cat > "${TARGET_DIR}/docs/index.md" <<EOF
# ${SUITE_NAME}

Stryker mutation testing for **${TARGET_SERVICE}**.
Minimum score: **${MUTATION_SCORE}%**. Test runner: **${TEST_RUNNER}**.
EOF
}

scaffold_testcontainers() {
  write_mkdocs
  write_catalog_info "testcontainers,integration-testing,testing,qa"
  write_node_package \
    '    "@types/jest": "^29.0.0",
    "jest": "^29.0.0",
    "testcontainers": "^10.9.0",
    "ts-jest": "^29.0.0",
    "typescript": "^5.4.0"' \
    "jest"

  mkdir -p "${TARGET_DIR}/tests" "${TARGET_DIR}/reports"

  cat > "${TARGET_DIR}/jest.config.js" <<'EOF'
module.exports = { preset: 'ts-jest', testEnvironment: 'node', testTimeout: 60000 };
EOF

  cat > "${TARGET_DIR}/tests/integration.spec.ts" <<EOF
import { GenericContainer, Wait } from 'testcontainers';

describe('${TARGET_SERVICE} integration', () => {
  const stopped: Array<{ stop: () => Promise<void> }> = [];
  afterAll(async () => { await Promise.all(stopped.map((c) => c.stop())); });

  test('postgres container starts', async () => {
    const pg = await new GenericContainer('postgres:16-alpine')
      .withEnvironment({ POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'testdb' })
      .withWaitStrategy(Wait.forLogMessage('database system is ready to accept connections'))
      .withExposedPorts(5432)
      .start();
    stopped.push(pg);

    expect(pg.getMappedPort(5432)).toBeGreaterThan(0);
    // Add your service integration assertions here
  });
});
EOF

  cat > "${TARGET_DIR}/README.md" <<EOF
# ${SUITE_NAME}

Testcontainers integration tests for \`${TARGET_SERVICE}\`.
Containers: **${CONTAINERS}**.

\`\`\`bash
npm install
npm test   # Docker must be running
\`\`\`
EOF

  cat > "${TARGET_DIR}/docs/index.md" <<EOF
# ${SUITE_NAME}

Testcontainers integration tests for **${TARGET_SERVICE}**.
Real containers (${CONTAINERS}) spin up in CI — no mocks.
EOF
}

# ── Dispatch ──────────────────────────────────────────────────────────────────
case "$SUITE_TYPE" in
  playwright)      scaffold_playwright ;;
  k6)              scaffold_k6 ;;
  pact)            scaffold_pact ;;
  newman)          scaffold_newman ;;
  zap)             scaffold_zap ;;
  datadog)         scaffold_datadog ;;
  visual)          scaffold_visual ;;
  accessibility)   scaffold_accessibility ;;
  cucumber)        scaffold_cucumber ;;
  appium)          scaffold_appium ;;
  chaos)           scaffold_chaos ;;
  mutation)        scaffold_mutation ;;
  testcontainers)  scaffold_testcontainers ;;
esac

# ── catalog-info guard ────────────────────────────────────────────────────────
[[ ! -f "${TARGET_DIR}/catalog-info.yaml" ]] && \
  write_catalog_info "${SUITE_TYPE},testing,qa"

# ── Git commit ────────────────────────────────────────────────────────────────
cd "${ROOT_DIR}"
if git rev-parse --is-inside-work-tree &>/dev/null 2>&1; then
  git add "test-suites/${SUITE_NAME}/"
  git diff --cached --quiet || {
    git commit -m "feat(qa): scaffold ${SUITE_TYPE} suite '${SUITE_NAME}' for ${TARGET_SERVICE}"
    log "Committed test-suites/${SUITE_NAME}/ to platform repo."
    git push 2>/dev/null && \
      log "Pushed to remote." || \
      log "Push failed — run: git push"
  }
fi

# ── Summary ───────────────────────────────────────────────────────────────────
log ""
log "✔  ${SUITE_NAME} (${SUITE_TYPE}) scaffolded at test-suites/${SUITE_NAME}/"
log ""
log "Next steps:"
log "  cd test-suites/${SUITE_NAME}"
case "$SUITE_TYPE" in
  playwright|visual|accessibility)
    log "  npm install && npx playwright install --with-deps"
    log "  npm test" ;;
  k6)
    log "  k6 run tests/smoke.js" ;;
  pact|newman|cucumber|mutation|testcontainers)
    log "  npm install && npm test" ;;
  zap)
    log "  docker run --rm -v \$(pwd)/reports:/zap/wrk:rw ghcr.io/zaproxy/zaproxy:stable zap-${SCAN_TYPE}.py -t ${TARGET_URL} -r zap-report.html" ;;
  datadog)
    log "  npm install"
    log "  DD_API_KEY=<key> DD_APP_KEY=<key> npm test" ;;
  appium)
    log "  npm install"
    log "  APP_PATH=/path/to/your.app npm test" ;;
  chaos)
    log "  kubectl apply -f experiments/pod-failure.yaml" ;;
esac
log ""
log "  Register in Backstage: open http://localhost:3000/catalog-import"
log "  and enter: https://github.com/${GH_ORG}/${SUITE_NAME}/blob/main/catalog-info.yaml"
