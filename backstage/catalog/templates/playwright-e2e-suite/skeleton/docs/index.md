# ${{ values.name }}

${{ values.description }}

## Overview

Playwright E2E test suite targeting **${{ values.targetService }}**.

- **Base URL:** `${{ values.baseUrl }}`
- **Owner:** ${{ values.owner }}

## Running Tests

```bash
npm install
npx playwright install --with-deps
npx playwright test
```

View the HTML report after a run:

```bash
npx playwright show-report
```

## CI

Tests run automatically on every push and pull request via GitHub Actions. The HTML report is uploaded as a workflow artifact and retained for 30 days.

## LambdaTest
{% if values.cloudGrid === 'lambdatest' %}
This suite is wired to run on the LambdaTest cloud grid. The `e2e-lambdatest`
job in `.github/workflows/e2e.yml` runs after the runner-local suite, on `main`
only, so cloud minutes confirm a merge rather than every push.

`LT_USERNAME` and `LT_ACCESS_KEY` are injected as repository secrets by the
platform when it has them — nothing to set up by hand. If the job fails to
authenticate, ask a platform admin whether those values are set on the Backstage
backend (`local/backstage/.env` locally, the `backstage-secrets` secret on AWS).

The grid endpoint is built in `playwright.config.ts`: Playwright reaches a
remote grid through `connectOptions.wsEndpoint`, not through environment
variables, so the capabilities travel encoded in that URL.
{% else %}
This suite runs its browsers on the GitHub runner. To move it to the LambdaTest
cloud grid, re-run the **Playwright E2E Suite** template with **Cloud Browser
Grid** set to *LambdaTest* — that generates the `connectOptions` wiring in
`playwright.config.ts` plus a dedicated CI job, and the platform injects
`LT_USERNAME` / `LT_ACCESS_KEY` for you.

Setting those two secrets by hand is not enough on its own: Playwright will not
route to a remote grid without the `connectOptions` endpoint.
{% endif %}
