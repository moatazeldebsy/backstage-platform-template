{% if values.language == 'javascript' %}
const { Pact } = require('@pact-foundation/pact');
const path = require('path');
const fetch = require('node-fetch');

const provider = new Pact({
  consumer: '${{ values.consumerName }}',
  provider: '${{ values.providerName }}',
  port: 1234,
  log: path.resolve(process.cwd(), 'logs', 'pact.log'),
  dir: path.resolve(process.cwd(), 'pacts'),
  logLevel: 'warn',
});

describe('${{ values.consumerName }} → ${{ values.providerName }} contract', () => {
  beforeAll(() => provider.setup());
  afterAll(() => provider.finalize());

  describe('GET /healthz', () => {
    beforeEach(() =>
      provider.addInteraction({
        state: 'provider is healthy',
        uponReceiving: 'a health check request',
        withRequest: {
          method: 'GET',
          path: '/healthz',
          headers: { Accept: 'application/json' },
        },
        willRespondWith: {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: { status: 'ok' },
        },
      })
    );

    it('returns 200 with status ok', async () => {
      const res = await fetch(`http://localhost:1234/healthz`, {
        headers: { Accept: 'application/json' },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ok');
    });

    afterEach(() => provider.verify());
  });
});
{% endif %}
{% if values.language == 'python' %}
// This file is intentionally empty — this suite uses Python (see src/test_consumer.py).
{% endif %}
