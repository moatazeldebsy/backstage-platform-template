#!/usr/bin/env bash
# Verify the Engineering Intelligence layer end to end, without a Kind cluster.
#
# Boots the real Backstage image against a real Postgres, with a small stub
# standing in for Prometheus and OpenCost, then asserts the collected numbers
# are what the fixtures imply. About two minutes warm, versus ~19 for a cold
# bootstrap-local.sh.
#
# What this proves that unit tests cannot:
#   - the plugin initialises and creates its Postgres schema
#   - every route answers, and answers 401 without a token
#   - the scoring arithmetic on real collected samples (evidence sums to score)
#   - snapshots round-trip through the jsonb column
#   - the dashboard renders (with --screenshot)
#
# What it deliberately does not prove: real Prometheus and OpenCost response
# shapes. Those are stubbed here; only a real cluster exercises them.
#
# Usage:
#   ./scripts/verify-engineering-intelligence.sh              # build if needed, verify
#   ./scripts/verify-engineering-intelligence.sh --rebuild    # force an image rebuild
#   ./scripts/verify-engineering-intelligence.sh --screenshot # also render the page
#                                                             # (written to $TMPDIR)
#   ./scripts/verify-engineering-intelligence.sh --keep       # leave containers running
#
# The script exits non-zero on a failed check. If you pipe it (`| tail`), set
# `pipefail` in the caller or the pipeline reports the exit status of `tail` and
# a real failure looks like success.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURES="${REPO_ROOT}/local/engineering-intelligence"
IMAGE="backstage:ei-verify"
NETWORK="ei-verify"
PORT=7099
API="http://localhost:${PORT}/api/engineering-intelligence"

REBUILD=false
SCREENSHOT=false
KEEP=false
for arg in "$@"; do
  case "$arg" in
    --rebuild)    REBUILD=true ;;
    --screenshot) SCREENSHOT=true ;;
    --keep)       KEEP=true ;;
    -h|--help)    sed -n '2,25p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

log()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf '\033[31mFAIL\033[0m %s\n' "$*"; FAILURES=$((FAILURES + 1)); }
ok()   { printf '\033[32m  ok\033[0m %s\n' "$*"; }
FAILURES=0

cleanup() {
  if [[ "$KEEP" == true ]]; then
    echo
    echo "Left running (--keep). Dashboard: http://localhost:${PORT}/engineering-intelligence"
    echo "Tear down with: docker rm -f ei-backstage ei-stub ei-postgres && docker network rm ${NETWORK}"
    return
  fi
  log "Cleaning up"
  docker rm -f ei-backstage ei-stub ei-postgres >/dev/null 2>&1 || true
  docker network rm "${NETWORK}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "docker is not running" >&2; exit 1; }

# ── image ─────────────────────────────────────────────────────────────────────

if [[ "$REBUILD" == true ]] || ! docker image inspect "${IMAGE}" >/dev/null 2>&1; then
  log "Building ${IMAGE} (this is the slow part — several minutes cold)"
  docker build -t "${IMAGE}" -f "${REPO_ROOT}/backstage/Dockerfile" "${REPO_ROOT}/backstage/app"
else
  log "Reusing existing ${IMAGE} (pass --rebuild after changing Backstage source)"
fi

# ── dependencies ──────────────────────────────────────────────────────────────

log "Starting Postgres and the metrics stub"
docker rm -f ei-backstage ei-stub ei-postgres >/dev/null 2>&1 || true
docker network create "${NETWORK}" >/dev/null 2>&1 || true

docker run -d --name ei-postgres --network "${NETWORK}" \
  -e POSTGRES_USER=backstage -e POSTGRES_PASSWORD=backstage -e POSTGRES_DB=backstage \
  pgvector/pgvector:pg17 >/dev/null

docker run -d --name ei-stub --network "${NETWORK}" \
  -v "${FIXTURES}:/verify:ro" node:22-alpine node /verify/stub.mjs >/dev/null

until docker exec ei-postgres pg_isready -U backstage >/dev/null 2>&1; do sleep 2; done
ok "Postgres accepting connections"

log "Starting Backstage"
docker run -d --name ei-backstage --network "${NETWORK}" -p "${PORT}:7007" \
  -v "${FIXTURES}:/verify:ro" \
  "${IMAGE}" node packages/backend --config /verify/app-config.yaml >/dev/null

# Readiness is "the init line appeared"; failure is "the container is gone".
# An earlier version also treated any log line matching /Unhandled rejection/ as
# fatal, which made the script fail intermittently on startups that went on to
# succeed — a flaky verification script is worse than none, because it teaches
# you to ignore it. Container liveness is unambiguous; log greps are not.
STARTED=false
for _ in $(seq 1 120); do
  if docker logs ei-backstage 2>&1 | grep -q "Plugin initialization complete"; then
    STARTED=true
    break
  fi
  if [[ "$(docker inspect -f '{{.State.Running}}' ei-backstage 2>/dev/null)" != "true" ]]; then
    echo "Backstage exited during startup:" >&2
    docker logs ei-backstage 2>&1 | tail -40 >&2
    exit 1
  fi
  sleep 2
done
[[ "$STARTED" == true ]] || {
  echo "Backstage did not finish starting within 240s" >&2
  docker logs ei-backstage 2>&1 | tail -40 >&2
  exit 1
}
ok "Backstage started"

# ── assertions ────────────────────────────────────────────────────────────────

log "Checking the API"

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "${API}/health")
[[ "$code" == "401" ]] && ok "unauthenticated /health -> 401" \
  || fail "unauthenticated /health returned ${code}, expected 401"

TOKEN=$(curl -s -X POST "http://localhost:${PORT}/api/auth/guest/refresh" \
  -H 'Content-Type: application/json' | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
[[ -n "$TOKEN" ]] || { echo "could not mint a guest token" >&2; exit 1; }

auth_get() { curl -s --max-time 120 -H "Authorization: Bearer ${TOKEN}" "$@"; }

# Wait for the catalog to finish ingesting the fixture before collecting.
#
# The catalog processes its file location asynchronously, so a collection that
# fires too early sees a partial catalog: an earlier run counted 2 of the 4
# Components and the golden-path assertions failed against a correct build.
# Without this the harness is a race, and a flaky verification script teaches you
# to ignore it.
EXPECTED_COMPONENTS=4
for _ in $(seq 1 60); do
  count=$(auth_get "http://localhost:${PORT}/api/catalog/entities?filter=kind=component&fields=metadata.name" \
    | grep -o '"name"' | wc -l | tr -d ' ')
  [[ "${count:-0}" -ge "$EXPECTED_COMPONENTS" ]] && break
  sleep 2
done
ok "catalog ingested ${count:-0} Components"

# Collect again now the catalog is complete — the first collection happened on
# whatever had been ingested at the time.
auth_get -o /dev/null -X POST "${API}/refresh"

for path in health maturity platform ai-readiness recommendations snapshots dimensions/platform; do
  code=$(auth_get -o /dev/null -w '%{http_code}' "${API}/${path}")
  [[ "$code" == "200" ]] && ok "GET /${path} -> 200" || fail "GET /${path} -> ${code}"
done

code=$(auth_get -o /dev/null -w '%{http_code}' "${API}/dimensions/nonsense")
[[ "$code" == "404" ]] && ok "GET /dimensions/nonsense -> 404" \
  || fail "unknown dimension returned ${code}, expected 404"

HEALTH=$(auth_get "${API}/health")
PLATFORM=$(auth_get "${API}/platform")
READINESS=$(auth_get "${API}/ai-readiness")

log "Checking the collected numbers"

# The fixtures make every figure below deterministic, so these are exact rather
# than "looks plausible" assertions. See local/engineering-intelligence/stub.mjs.
# `|| PY_STATUS=$?` rather than a bare call: `set -e` would abort the script on a
# failing assertion before the status could be captured, losing the summary.
PY_STATUS=0
python3 - "$HEALTH" "$PLATFORM" "$READINESS" <<'PY' || PY_STATUS=$?
import json, sys

health, platform = json.loads(sys.argv[1]), json.loads(sys.argv[2])
readiness = json.loads(sys.argv[3])
dims, failures = health["dimensions"], 0

def check(label, actual, expected):
    global failures
    if actual == expected:
        print(f"\033[32m  ok\033[0m {label}: {actual}")
    else:
        print(f"\033[31mFAIL\033[0m {label}: got {actual!r}, expected {expected!r}")
        failures += 1

def close(label, actual, expected, tol=0.15):
    global failures
    if actual is not None and abs(actual - expected) <= tol:
        print(f"\033[32m  ok\033[0m {label}: {actual}")
    else:
        print(f"\033[31mFAIL\033[0m {label}: got {actual!r}, expected ~{expected}")
        failures += 1

close("platform score",    dims["platform"]["score"],    73.5)
close("devEx score",       dims["devEx"]["score"],       80.1)
close("quality score",     dims["quality"]["score"],     89.1)
close("reliability score", dims["reliability"]["score"], 100)
close("finops score",      dims["finops"]["score"],      63.8)
close("overall score",     health["overallScore"],       81.3)

# The dimensions with no source must withhold a number, never report a zero.
for name in ("aiEngineering", "security"):
    check(f"{name} withheld", dims[name]["score"], None)
    check(f"{name} status", dims[name]["status"], "insufficient-evidence")

# Every score decomposes into evidence whose impacts add up to it. This is the
# property that makes a score explainable rather than asserted.
mismatched = []
for name, dim in dims.items():
    if dim["score"] is None:
        continue
    summed = round(sum(e["impact"] for e in dim["evidence"]), 1)
    if abs(summed - dim["score"]) > 0.3:
        mismatched.append(f"{name} sums to {summed}, score is {dim['score']}")
if mismatched:
    for m in mismatched:
        print(f"\033[31mFAIL\033[0m evidence {m}")
    failures += len(mismatched)
else:
    print("\033[32m  ok\033[0m every dimension's evidence sums to its score")

check("maturity level", health["maturity"]["currentLevel"], 3)
check("maturity unconfirmed", health["maturity"]["confirmed"], False)

# devEx is the phase-5 proof: it scored nothing at all before the exporter
# published devex_*.
devex_metrics = {e["metric"] for e in dims["devEx"]["evidence"]}
check("devEx signals collected", len(devex_metrics), 4)

check("platform breakdown available", platform["available"], True)
check("services counted", platform["services"], 4)
check("not on golden path", platform["notOnGoldenPath"]["count"], 2)
# Nothing has been scaffolded, so self-service is unmeasurable — not 0%, not 100%.
check("self-service unmeasured", platform["selfService"], {"completed": 0, "failed": 0, "inFlight": 0})

# AI readiness (phase 6). MLflow and Langfuse are not stubbed here, so only the
# Tech-Insights-backed and Prometheus-backed areas can score — which is also the
# realistic state of most installs.
check("readiness areas", len(readiness["areas"]), 12)
check("readiness total", readiness["total"], 12)
# The six areas with no collector must withhold, never report zero.
for area in ("security", "privacy", "architecture", "testing", "cost", "incidentManagement"):
    check(f"readiness {area} withheld", readiness["areas"][area]["score"], None)
# ...and each names what it is waiting on rather than just failing silently.
arch = readiness["areas"]["architecture"]["missing"][0]["expectedFrom"]
check("architecture needs human review", "human review" in arch, True)

sys.exit(1 if failures else 0)
PY
[[ $PY_STATUS -eq 0 ]] || FAILURES=$((FAILURES + 1))

# ── snapshots ─────────────────────────────────────────────────────────────────

log "Checking the snapshot store"
auth_get -o /dev/null -X POST "${API}/refresh"
COUNT=$(docker exec ei-postgres psql -U backstage -d "backstage_plugin_engineering-intelligence" \
  -t -A -c "select count(*) from ei_snapshots;" 2>/dev/null | tr -d '[:space:]')
[[ "${COUNT:-0}" -ge 2 ]] && ok "${COUNT} snapshots persisted" \
  || fail "expected at least 2 snapshots, found ${COUNT:-0}"

# ── optional screenshot ───────────────────────────────────────────────────────

if [[ "$SCREENSHOT" == true ]]; then
  log "Rendering the dashboard"
  # Written outside the working tree: the script runs from a clean checkout in
  # CI, and dropping an untracked PNG into backstage/app would show up in every
  # subsequent `git status`.
  OUT="${TMPDIR:-/tmp}/ei-dashboard.png"
  # Run from backstage/app so @playwright/test resolves from its node_modules.
  (cd "${REPO_ROOT}/backstage/app" && node - "$OUT" <<'JS'
import { chromium } from '@playwright/test';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1400 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto('http://localhost:7099/engineering-intelligence', { waitUntil: 'load', timeout: 90000 });
await page.getByRole('button', { name: /enter/i }).click({ timeout: 20000 }).catch(() => {});
await page.waitForSelector('text=Platform Health', { timeout: 60000 });
await page.waitForTimeout(2000);
await page.screenshot({ path: process.argv[2], fullPage: true });
console.log(errors.length ? `console errors: ${errors.slice(0, 3)}` : 'no console errors');
console.log(`screenshot -> ${process.argv[2]}`);
await browser.close();
JS
  ) || fail "screenshot failed"
fi

# ── result ────────────────────────────────────────────────────────────────────

echo
if [[ $FAILURES -eq 0 ]]; then
  printf '\033[32mPASS\033[0m Engineering Intelligence verified end to end.\n'
else
  printf '\033[31m%d check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi
