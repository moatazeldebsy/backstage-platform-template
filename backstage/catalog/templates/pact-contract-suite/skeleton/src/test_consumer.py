{% if values.language == 'python' %}
import os
import pytest
import requests
from pact import Consumer, Provider

PACT_DIR = os.path.join(os.path.dirname(__file__), '..', 'pacts')
os.makedirs(PACT_DIR, exist_ok=True)

pact = Consumer('${{ values.consumerName }}').has_pact_with(
    Provider('${{ values.providerName }}'),
    pact_dir=PACT_DIR,
)


def test_health_check():
    (
        pact
        .given('provider is healthy')
        .upon_receiving('a health check request')
        .with_request('GET', '/healthz', headers={'Accept': 'application/json'})
        .will_respond_with(200, body={'status': 'ok'})
    )

    with pact:
        result = requests.get(
            f'{pact.uri}/healthz',
            headers={'Accept': 'application/json'},
        )

    assert result.status_code == 200
    assert result.json()['status'] == 'ok'
{% endif %}
{% if values.language == 'javascript' %}
# This file is intentionally empty — this suite uses JavaScript (see src/consumer.test.js).
{% endif %}
