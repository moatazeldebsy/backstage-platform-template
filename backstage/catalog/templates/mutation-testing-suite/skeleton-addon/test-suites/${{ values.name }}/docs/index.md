# ${{ values.name }}

${{ values.description }}

## Overview

Stryker mutation testing configuration for **${{ values.targetService }}**.

| Parameter | Value |
|-----------|-------|
| Test runner | `${{ values.testRunner }}` |
| Minimum score | `${{ values.mutationScore }}%` |

## What is mutation testing?

Stryker makes small changes (mutations) to your production code — flipping a `>` to `<`, removing a `return` statement, etc. — then runs your test suite. If a test catches the mutation, the mutant is "killed". If all tests pass despite the mutation, the mutant "survived".

**Mutation score = killed / total × 100**. A score below **${{ values.mutationScore }}%** means your tests aren't catching enough bugs.

## Running locally

```bash
npm install
npm test
# HTML report: reports/mutation/index.html
```

## CI

Runs on every push to main and on a weekly schedule. The build fails if the mutation score drops below **${{ values.mutationScore }}%**.
