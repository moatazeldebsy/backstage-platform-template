# ${{ values.name }}

${{ values.description }}

Axe-core + Playwright accessibility suite for `${{ values.targetService }}`. Enforces **${{ values.wcagLevel }}**.

## Quick start

```bash
npm install
npx playwright install chromium --with-deps
npm test
```
