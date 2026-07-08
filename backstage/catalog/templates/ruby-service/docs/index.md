# Ruby Sinatra Service

Scaffold a Ruby Sinatra service with CI/CD and Helm deployment

## How to use

1. Open Backstage → **Create**
2. Find **Ruby Sinatra Service** and click **Choose**
3. Fill in the required parameters and click **Create**

## When to use this template

This is the golden path for services **extracted from the Ruby monolith** during the strangler-fig migration —
it gives an extracted module the same CI/CD, catalog, observability, and contract-testing conventions as every
other service on the platform, without requiring a rewrite into another language first.

## Source

Template definition: [`template.yaml`](../template.yaml)
