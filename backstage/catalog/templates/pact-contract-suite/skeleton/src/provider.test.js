{% if values.language == 'javascript' %}
const { Verifier } = require('@pact-foundation/pact');
const path = require('path');

describe('${{ values.providerName }} provider verification', () => {
  it('validates pacts from consumers', () => {
    const providerBaseUrl = process.env.PROVIDER_BASE_URL || '${{ values.providerBaseUrl }}';
    const brokerUrl = process.env.PACT_BROKER_URL;
    const brokerToken = process.env.PACT_BROKER_TOKEN;

    const opts = {
      provider: '${{ values.providerName }}',
      providerBaseUrl,
      logLevel: 'warn',
    };

    if (brokerUrl) {
      opts.pactBrokerUrl = brokerUrl;
      if (brokerToken) opts.pactBrokerToken = brokerToken;
      opts.consumerVersionSelectors = [{ mainBranch: true }, { deployedOrReleased: true }];
      opts.publishVerificationResult = process.env.CI === 'true';
      opts.providerVersion = process.env.GITHUB_SHA || 'local';
    } else {
      opts.pactUrls = [
        path.resolve(
          process.cwd(),
          'pacts',
          '${{ values.consumerName }}-${{ values.providerName }}.json'
        ),
      ];
    }

    return new Verifier(opts).verifyProvider();
  });
});
{% endif %}
{% if values.language == 'python' %}
// This file is intentionally empty — this suite uses Python (see src/test_provider.py).
{% endif %}
