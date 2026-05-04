# ${{ values.name }}

${{ values.description }}

## Overview

Playwright visual regression suite for **${{ values.targetService }}**.

- **Base URL:** `${{ values.baseUrl }}`
- **Max pixel diff:** ${{ values.diffThreshold }}%

## Workflow

1. Run `npm run test:update` to capture the initial golden screenshots.
2. Commit `tests/__snapshots__/` to git — this is your baseline.
3. On every PR, `npm test` compares against the baseline and fails if diff exceeds **${{ values.diffThreshold }}%**.
4. When a UI change is intentional, re-run `npm run test:update` and commit the updated snapshots.

## CI

GitHub Actions runs the comparison on every push and PR. Diff images are uploaded as workflow artifacts for review.
