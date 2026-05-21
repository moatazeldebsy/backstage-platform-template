import { describe, it, expect, beforeAll } from 'vitest';

const SERVICE_URL = process.env.SERVICE_URL ?? 'http://localhost:8080';
const WIREMOCK_URL = process.env.WIREMOCK_URL ?? 'http://localhost:8089';

async function resetWireMock(): Promise<void> {
  await fetch(`${WIREMOCK_URL}/__admin/requests`, { method: 'DELETE' });
}

describe('service component tests', () => {
  beforeAll(async () => {
    await resetWireMock();
  });

  it('returns 200 from healthz', async () => {
    const res = await fetch(`${SERVICE_URL}/healthz`);
    expect(res.status).toBe(200);
  });

  it.skip('calls the stubbed downstream and returns enriched response', async () => {
    // Example: WireMock mapping in ./wiremock/mappings/ stubs GET /downstream/foo.
    // The service-under-test should call DOWNSTREAM_BASE_URL/downstream/foo
    // and aggregate the response. Adapt to your service's actual route.
    const res = await fetch(`${SERVICE_URL}/widgets/foo`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ id: 'foo' });
  });
});
