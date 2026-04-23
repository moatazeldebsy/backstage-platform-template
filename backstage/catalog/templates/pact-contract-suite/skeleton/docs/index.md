# ${{ values.name }}

${{ values.description }}

## Consumer / Provider

| Role | Service |
|------|---------|
| **Consumer** | `${{ values.consumerName }}` |
| **Provider** | `${{ values.providerName }}` |
| **Provider URL** | `${{ values.providerBaseUrl }}` |
| **Language** | `${{ values.language }}` |

## How contract testing works

1. The **consumer** test defines the interactions it expects from the provider and writes a Pact file (`pacts/`).
2. The **provider** verification test replays those interactions against the real provider.
3. Both sides publish results to the Pact Broker so teams can deploy independently with confidence.

## Running locally

{% if values.language == 'javascript' %}
```bash
npm install

# Run consumer tests (generates ./pacts/)
npm run test:consumer

# Verify against the live provider
PROVIDER_BASE_URL=${{ values.providerBaseUrl }} npm run test:provider
```
{% endif %}
{% if values.language == 'python' %}
```bash
pip install -r requirements.txt

# Run consumer tests (generates ./pacts/)
pytest src/test_consumer.py -v

# Verify against the live provider
PROVIDER_BASE_URL=${{ values.providerBaseUrl }} pytest src/test_provider.py -v
```
{% endif %}

## CI/CD

| Trigger | Job |
|---------|-----|
| Push / PR | Consumer tests → publish pacts to broker (if `PACT_BROKER_URL` set) |
| Schedule (weekdays 04:00 UTC) + manual | Provider verification |

### Required secrets

| Secret | Purpose |
|--------|---------|
| `PACT_BROKER_URL` | Pact Broker base URL (optional — skipped if absent) |
| `PACT_BROKER_TOKEN` | Auth token for the broker (optional) |
