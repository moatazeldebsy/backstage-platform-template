# ${{ values.name }}

Consumer-driven contract tests between **${{ values.consumerName }}** (consumer) and **${{ values.providerName }}** (provider).

| Detail | Value |
|--------|-------|
| Consumer | `${{ values.consumerName }}` |
| Provider | `${{ values.providerName }}` |
| Provider URL | `${{ values.providerBaseUrl }}` |
| Language | `${{ values.language }}` |
| Owner | `${{ values.owner }}` |

## How it works

1. **Consumer tests** define the interactions they expect from the provider and generate a Pact file.
2. **Provider verification** replays those interactions against the real provider to confirm compatibility.
3. Both sides publish results to the Pact Broker so teams can deploy independently with confidence.

## Local setup

{% if values.language == 'javascript' %}
```bash
npm install
npm test                   # run consumer tests, write ./pacts/
```

To verify against the provider locally:
```bash
PROVIDER_BASE_URL=${{ values.providerBaseUrl }} npx jest --testPathPattern=provider
```
{% endif %}
{% if values.language == 'python' %}
```bash
pip install -r requirements.txt
pytest src/test_consumer.py -v   # generate ./pacts/
```

To verify against the provider locally:
```bash
PROVIDER_BASE_URL=${{ values.providerBaseUrl }} pytest src/test_provider.py -v
```
{% endif %}

## CI/CD

The workflow in `.github/workflows/ci.yml`:

- **On every push / PR** — runs consumer tests and uploads pact files as artifacts.
- **If `PACT_BROKER_URL` secret is set** — publishes pacts to the broker tagged with the git SHA.
- **On schedule + `workflow_dispatch`** — runs provider verification against `${{ values.providerBaseUrl }}`.

### Required secrets

| Secret | Purpose |
|--------|---------|
| `PACT_BROKER_URL` | Pact Broker base URL (optional; skipped if absent) |
| `PACT_BROKER_TOKEN` | Bearer token for Pact Broker (optional) |

## Pact Broker

If you have a broker running, set `PACT_BROKER_URL` in your repository secrets. Pacts are published with the consumer version set to the short git SHA and tagged `main` on main-branch builds.
