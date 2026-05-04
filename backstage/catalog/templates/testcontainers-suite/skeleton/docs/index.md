# ${{ values.name }}

${{ values.description }}

## Overview

Testcontainers integration test suite for **${{ values.targetService }}**.

- **Test runner:** `${{ values.testRunner }}`
- **Containers:** ${{ values.containers | join(', ') }}

## How it works

Each test starts real Docker containers for the listed dependencies, runs the integration tests against them, then stops the containers. No mocks, no external infra — the same databases and queues used in production.

## Running locally

Docker Desktop (or equivalent) must be running.

```bash
npm install
npm test
```

## CI

GitHub Actions uses the `ubuntu-latest` runner which has Docker pre-installed. Tests run on every push and PR. Container startup adds ~10–30s depending on image sizes.

## Adding tests

1. Import the container you need from `testcontainers`
2. Start it in `beforeAll` / the test body
3. Get the mapped port with `container.getMappedPort()`
4. Run your assertions
5. Stop the container in `afterAll`
