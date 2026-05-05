# ${{ values.name }}

${{ values.description }}

## Overview

Cucumber.js BDD test suite for **${{ values.targetService }}**.

- **Base URL:** `${{ values.baseUrl }}`
- **Report format:** `${{ values.format }}`

## Structure

```
features/         Gherkin .feature files (business-readable)
steps/            TypeScript step definitions
reports/          JUnit XML + HTML output
cucumber.js       Runner configuration
```

## Running locally

```bash
npm install
BASE_URL=http://staging.example.com npm test
```

## Writing scenarios

Feature files use plain English. Anyone on the team can read and contribute to them — no code knowledge needed. Step definitions live in `steps/` and wire the Gherkin sentences to real HTTP calls or UI actions.
