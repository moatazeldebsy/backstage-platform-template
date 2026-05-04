# ${{ values.name }}

${{ values.description }}

## Overview

Pact consumer-driven contract tests for the **${{ values.consumerName }}** → **${{ values.providerName }}** integration.

| Parameter | Value |
|-----------|-------|
| Consumer | `${{ values.consumerName }}` |
| Provider | `${{ values.providerName }}` |
| Provider URL | `${{ values.providerBaseUrl }}` |
| Pact Broker | `${{ values.pactBrokerUrl }}` |

## How It Works

1. The consumer test defines the expected API interactions and generates a pact file.
2. The pact is published to PactFlow so the provider team can verify it.
3. The provider CI fetches the pact and runs verification against the real implementation.

## Running Locally

```bash
npm install

# Run consumer tests (generates pact files in ./pacts/)
npm test

# Verify as provider (requires running provider at PROVIDER_BASE_URL)
PROVIDER_BASE_URL=${{ values.providerBaseUrl }} npm run verify
```

## Publishing Contracts

Set the `PACT_BROKER_TOKEN` secret in GitHub repository settings, then contracts publish automatically on every main branch push.

## Links

- [PactFlow Broker](${{ values.pactBrokerUrl }})
- [Pact Documentation](https://docs.pact.io)
