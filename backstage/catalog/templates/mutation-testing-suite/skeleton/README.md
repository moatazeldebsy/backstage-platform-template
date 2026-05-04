# ${{ values.name }}

${{ values.description }}

Stryker mutation testing for `${{ values.targetService }}`. Minimum score: **${{ values.mutationScore }}%**.

## Quick start

Point `stryker.config.js` at the source and test files of the target service:

```bash
# In the target service directory
npm install --save-dev @stryker-mutator/core @stryker-mutator/${{ values.testRunner }}-runner
npx stryker run
```

Or run this suite standalone after copying stryker.config.js and adjusting the `mutate` glob.
