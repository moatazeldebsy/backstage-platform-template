import { PactV3, MatchersV3 } from '@pact-foundation/pact';
import * as path from 'path';

const { like } = MatchersV3;

const provider = new PactV3({
  consumer: '${{ values.consumerName }}',
  provider: '${{ values.providerName }}',
  dir: path.resolve(process.cwd(), 'pacts'),
});

describe('${{ values.consumerName }} → ${{ values.providerName }} contract', () => {
  it('returns a successful health response', async () => {
    await provider
      .given('the provider is healthy')
      .uponReceiving('a health check request')
      .withRequest({
        method: 'GET',
        path: '/healthz',
      })
      .willRespondWith({
        status: 200,
        headers: { 'Content-Type': like('application/json') },
        body: like({ status: 'ok' }),
      })
      .executeTest(async (mockServer) => {
        const response = await fetch(`${mockServer.url}/healthz`);
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toHaveProperty('status');
      });
  });
});
