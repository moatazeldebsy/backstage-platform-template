# ${{ values.name }}

${{ values.description }}

Pact consumer-driven contract tests: **${{ values.consumerName }}** → **${{ values.providerName }}**.

## Quick start

```bash
npm install
npm test                                           # generate pact files
PROVIDER_BASE_URL=${{ values.providerBaseUrl }} npm run verify  # verify as provider
```

## Structure

```
tests/
  consumer.pact.spec.ts   # consumer interaction definitions
pacts/                    # generated pact files (git-ignored)
package.json
```

## Broker

Contracts publish to `${{ values.pactBrokerUrl }}` on every push to main (requires `PACT_BROKER_TOKEN` secret).
