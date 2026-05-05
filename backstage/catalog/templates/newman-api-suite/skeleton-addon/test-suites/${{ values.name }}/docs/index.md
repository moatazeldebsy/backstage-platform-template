# ${{ values.name }}

${{ values.description }}

## Overview

Newman API test suite targeting **${{ values.targetService }}** at `${{ values.baseUrl }}`.

## Running Locally

```bash
npm install

# Run the full collection
npm test

# Run against a different environment URL
BASE_URL=http://staging.example.com npm test

# Generate HTML report
npm run report
```

## Structure

```
collections/
  ${{ values.name }}.postman_collection.json   # Postman collection
environments/
  dev.postman_environment.json                  # Dev environment variables
reports/                                        # Generated after a run (git-ignored)
```

## Importing into Postman

1. Open Postman → Import
2. Select `collections/${{ values.name }}.postman_collection.json`
3. Import `environments/dev.postman_environment.json`
4. Set `baseUrl` variable to your target

## CI

GitHub Actions runs the full collection on every push and PR. JUnit XML results are published as a test report and retained as a workflow artifact.
