# ${{ values.name }}

${{ values.description }}

Testcontainers integration tests for `${{ values.targetService }}`.

## Quick start

Docker must be running locally.

```bash
npm install
npm test
```

Containers spin up automatically, tests run, containers stop. No external infrastructure needed.

## Configured containers

${{ values.containers | join(', ') }}
