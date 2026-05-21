import { PactV3, MatchersV3 } from '@pact-foundation/pact';
import * as path from 'path';

const { like } = MatchersV3;

const provider = new PactV3({
  consumer: '${{ values.consumerName }}',
  provider: '${{ values.providerName }}',
  dir: path.resolve(process.cwd(), 'pacts'),
});

describe('${{ values.consumerName }} → ${{ values.providerName }} contract', () => {
  it('provider health check returns ok', async () => {
    await provider
      .given('${{ values.providerName }} is available')
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
        const body = await response.json() as { status: string };
        expect(body.status).toBe('ok');
      });
  });

  // Add more interactions here — one test per API interaction your consumer uses.
  // Use the contract-assistant in Backstage to auto-generate tests from an OpenAPI spec:
  //   "Generate contract tests for ${{ values.providerName }} consumer ${{ values.consumerName }}"
});
