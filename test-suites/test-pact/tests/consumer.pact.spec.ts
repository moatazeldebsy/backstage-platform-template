import { PactV3, MatchersV3 } from '@pact-foundation/pact';
import * as path from 'path';

const { like } = MatchersV3;

const provider = new PactV3({
  consumer: 'test-pact-consumer',
  provider: 'hello-service',
  dir: path.resolve(process.cwd(), 'pacts'),
});

describe('test-pact-consumer → hello-service', () => {
  it('health endpoint responds', async () => {
    await provider
      .given('provider is healthy')
      .uponReceiving('a health check')
      .withRequest({ method: 'GET', path: '/healthz' })
      .willRespondWith({ status: 200, body: like({ status: 'ok' }) })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/healthz`);
        expect(res.status).toBe(200);
      });
  });
});
