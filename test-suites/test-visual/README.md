# test-visual

Visual regression suite for `hello-service`. Diff threshold: **0.2**.

```bash
npm install && npx playwright install chromium
npm run test:update   # capture baseline snapshots
npm test              # compare against baseline
```

Commit `tests/__snapshots__/` as the golden baseline.
