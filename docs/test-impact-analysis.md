# Test-Impact Analysis

How the python-service golden path keeps CI feedback fast on pull requests by running only the
tests actually impacted by the change, instead of the full suite on every push.

## The mechanism

`backstage/catalog/templates/python-service/skeleton/.github/workflows/ci.yml` installs
[`pytest-testmon`](https://pypi.org/project/pytest-testmon/) alongside the normal test dependencies
and branches CI behavior on event type:

- **On pull requests**: restores a `.testmondata` cache (keyed on the PR's base branch and run ID,
  with fallback restore-keys so a fresh PR still gets a usable cache), then runs
  `pytest -v --testmon --junit-xml=junit.xml`. `pytest-testmon` tracks which lines each test actually
  exercises and skips any test whose covered lines weren't touched by the diff. Exit status `5` (no
  impacted tests selected — e.g. a docs-only PR) is treated as success, not a failure.
- **On push to `main`** (i.e. after merge): runs the full suite with the existing 70% coverage gate,
  unconditionally. This is the safety net — nothing merges without the complete suite passing at least
  once, so the PR-time speedup never lets a change through unverified.

This means the two-stage CI a service already had (PR checks → main push) didn't change shape; the PR
stage just got selective instead of exhaustive.

## Why this matters at scale

As a service's test suite grows toward hundreds or thousands of tests, running everything on every PR
becomes the dominant cost of iteration speed. `pytest-testmon`'s coverage-based impact analysis means a
one-line change to a single module only re-runs the handful of tests that actually cover that module,
not the entire suite — while the full-suite run on `main` still catches anything the impact analysis
might have under-selected (e.g. changes to shared fixtures or dynamic imports that testmon's static
coverage mapping can miss).

## Scope

This is currently wired into the **python-service** golden-path template only
(`backstage/catalog/templates/python-service/skeleton/.github/workflows/ci.yml`). Other language
templates (Node.js, Go, Ruby, JVM) do not yet have an equivalent impacted-tests step — if a team wants
this for another language, look for that ecosystem's coverage-based selective-test-runner (e.g. Nx's
affected-graph for JS/TS monorepos, or Gradle's built-in test-task input tracking for JVM) rather than
assuming `pytest-testmon`'s approach ports directly.

## Caching notes

The `.testmondata` cache is keyed per PR base branch and run ID, with restore-keys that fall back to
the most recent cache for that base branch, then any `testmon-` prefixed cache. A completely fresh
cache (first PR against a new base branch) simply means `pytest-testmon` treats every test as
potentially impacted for that one run — it self-corrects on the next cached run.
