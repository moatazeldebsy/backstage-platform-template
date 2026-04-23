{% if values.language == 'python' %}
import os
import pytest
from pact import Verifier

PROVIDER_BASE_URL = os.environ.get('PROVIDER_BASE_URL', '${{ values.providerBaseUrl }}')
PACT_BROKER_URL = os.environ.get('PACT_BROKER_URL')
PACT_BROKER_TOKEN = os.environ.get('PACT_BROKER_TOKEN')
PACT_DIR = os.path.join(os.path.dirname(__file__), '..', 'pacts')


def test_provider_verification():
    verifier = Verifier(
        provider='${{ values.providerName }}',
        provider_base_url=PROVIDER_BASE_URL,
    )

    if PACT_BROKER_URL:
        output, _ = verifier.verify_with_broker(
            broker_url=PACT_BROKER_URL,
            broker_token=PACT_BROKER_TOKEN,
            consumer_selectors=[{'mainBranch': True}, {'deployedOrReleased': True}],
            publish_version_tags=['main'],
            enable_pending=True,
        )
    else:
        pact_file = os.path.join(
            PACT_DIR,
            '${{ values.consumerName }}-${{ values.providerName }}.json',
        )
        output, _ = verifier.verify_pacts(pact_file)

    assert output == 0, 'Provider verification failed — see output above'
{% endif %}
{% if values.language == 'javascript' %}
# This file is intentionally empty — this suite uses JavaScript (see src/provider.test.js).
{% endif %}
