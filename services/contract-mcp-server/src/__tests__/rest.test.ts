// REST API integration tests — use supertest against a real Express app
// backed by an in-memory ContractStore (no DB, no prom-client, no MCP).

import request from 'supertest';
import { createStore } from '../store.js';
import { createApp, parseServicesRegistry, resolveServiceBaseUrl } from '../app.js';

// Minimal valid OpenAPI 3.x spec used across tests.
const SPEC_V1 = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Hello Service', version: '1.0.0' },
  paths: {
    '/hello': { get: { responses: { '200': { description: 'OK' } } } },
    '/health': { get: { responses: { '200': { description: 'OK' } } } },
  },
});

const SPEC_V2 = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Hello Service', version: '2.0.0' },
  paths: {
    '/hello': { get: { responses: { '200': { description: 'OK' } } } },
    // /health removed → breaking change
  },
});

// ── parseServicesRegistry ─────────────────────────────────────────────────

describe('parseServicesRegistry', () => {
  it('returns empty map for empty string', () => {
    expect(parseServicesRegistry('')).toEqual(new Map());
  });

  it('parses a single service entry', () => {
    const m = parseServicesRegistry('payments=http://payments:8080');
    expect(m.get('payments')).toBe('http://payments:8080');
  });

  it('parses multiple comma-separated entries', () => {
    const m = parseServicesRegistry('a=http://a:80,b=http://b:81');
    expect(m.get('a')).toBe('http://a:80');
    expect(m.get('b')).toBe('http://b:81');
  });

  it('skips malformed entries with no =', () => {
    const m = parseServicesRegistry('bad-entry,ok=http://ok');
    expect(m.has('bad-entry')).toBe(false);
    expect(m.get('ok')).toBe('http://ok');
  });

  it('trims whitespace around name and url', () => {
    const m = parseServicesRegistry('  svc  =  http://svc:9000  ');
    expect(m.get('svc')).toBe('http://svc:9000');
  });

  it('reads from process.env.SERVICES_REGISTRY when no arg given', () => {
    process.env.SERVICES_REGISTRY = 'env-svc=http://env:80';
    const m = parseServicesRegistry();
    expect(m.get('env-svc')).toBe('http://env:80');
    delete process.env.SERVICES_REGISTRY;
  });
});

// ── resolveServiceBaseUrl ─────────────────────────────────────────────────

describe('resolveServiceBaseUrl', () => {
  describe('kubernetes mode (default)', () => {
    it('builds cluster-local URL from service name, namespace, port', () => {
      const url = resolveServiceBaseUrl('payments', 'services', 8080, 'kubernetes');
      expect(url).toBe('http://payments.services.svc.cluster.local:8080');
    });
  });

  describe('http mode', () => {
    beforeEach(() => {
      process.env.SERVICES_REGISTRY = 'payments=http://payments-svc:9090';
    });
    afterEach(() => {
      delete process.env.SERVICES_REGISTRY;
    });

    it('returns the registry URL with trailing slash stripped', () => {
      process.env.SERVICES_REGISTRY = 'payments=http://payments-svc:9090/';
      const url = resolveServiceBaseUrl('payments', 'services', 80, 'http');
      expect(url).toBe('http://payments-svc:9090');
    });

    it('throws when service is not in the registry', () => {
      expect(() => resolveServiceBaseUrl('unknown', 'services', 80, 'http')).toThrow(
        '"unknown" not found in SERVICES_REGISTRY',
      );
    });
  });
});

// ── REST API routes ───────────────────────────────────────────────────────

describe('REST API', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    const store = await createStore(); // always returns InMemoryStore in tests
    app = createApp(store);
  });

  // ── POST /api/contracts/:service/:version ─────────────────────────────

  describe('POST /api/contracts/:service/:version', () => {
    it('registers a new contract and returns 200 with path count', async () => {
      const res = await request(app)
        .post('/api/contracts/hello-service/1.0.0')
        .set('Content-Type', 'application/json')
        .send(SPEC_V1);
      expect(res.status).toBe(200);
      expect(res.body.registered).toBe(true);
      expect(res.body.service).toBe('hello-service');
      expect(res.body.version).toBe('1.0.0');
      expect(res.body.pathCount).toBe(2);
    });

    it('accepts YAML content-type', async () => {
      const yamlSpec = 'openapi: "3.0.0"\ninfo:\n  title: yaml-svc\n  version: "1.0.0"\npaths:\n  /ping:\n    get:\n      responses:\n        "200":\n          description: OK\n';
      const res = await request(app)
        .post('/api/contracts/yaml-svc/1.0.0')
        .set('Content-Type', 'application/x-yaml')
        .send(yamlSpec);
      expect(res.status).toBe(200);
      expect(res.body.pathCount).toBe(1);
    });

    it('returns 400 when the spec is invalid', async () => {
      // A lone '{' is an incomplete YAML flow mapping — yaml.load throws.
      const res = await request(app)
        .post('/api/contracts/bad-svc/1.0.0')
        .set('Content-Type', 'text/plain')
        .send('{');
      expect(res.status).toBe(400);
      expect(res.body.error).toBeTruthy();
    });

    it('returns 401 when API key is configured but missing', async () => {
      const store = await createStore();
      const secured = createApp(store, { apiKey: 'secret-key' });
      const res = await request(secured)
        .post('/api/contracts/svc/1.0.0')
        .set('Content-Type', 'application/json')
        .send(SPEC_V1);
      expect(res.status).toBe(401);
    });

    it('allows request when correct API key is provided', async () => {
      const store = await createStore();
      const secured = createApp(store, { apiKey: 'secret-key' });
      const res = await request(secured)
        .post('/api/contracts/svc/1.0.0')
        .set('Content-Type', 'application/json')
        .set('X-Api-Key', 'secret-key')
        .send(SPEC_V1);
      expect(res.status).toBe(200);
    });
  });

  // ── GET /api/contracts/:service ───────────────────────────────────────

  describe('GET /api/contracts/:service', () => {
    it('returns 404 when no contract is registered', async () => {
      const res = await request(app).get('/api/contracts/unknown-svc');
      expect(res.status).toBe(404);
    });

    it('returns the latest contract after registration', async () => {
      await request(app)
        .post('/api/contracts/hello-service/1.0.0')
        .set('Content-Type', 'application/json')
        .send(SPEC_V1);
      const res = await request(app).get('/api/contracts/hello-service');
      expect(res.status).toBe(200);
      expect(res.body.service).toBe('hello-service');
      expect(res.body.version).toBe('1.0.0');
      expect(Array.isArray(res.body.paths)).toBe(true);
      expect(res.body.spec).toBeTruthy();
    });

    it('returns a specific version when ?version= is provided', async () => {
      await request(app)
        .post('/api/contracts/hello-service/1.0.0')
        .set('Content-Type', 'application/json')
        .send(SPEC_V1);
      await request(app)
        .post('/api/contracts/hello-service/2.0.0')
        .set('Content-Type', 'application/json')
        .send(SPEC_V2);
      const res = await request(app).get('/api/contracts/hello-service?version=1.0.0');
      expect(res.status).toBe(200);
      expect(res.body.version).toBe('1.0.0');
    });

    it('returns 404 when the specified version does not exist', async () => {
      await request(app)
        .post('/api/contracts/hello-service/1.0.0')
        .set('Content-Type', 'application/json')
        .send(SPEC_V1);
      const res = await request(app).get('/api/contracts/hello-service?version=9.9.9');
      expect(res.status).toBe(404);
    });
  });

  // ── GET /api/contracts ────────────────────────────────────────────────

  describe('GET /api/contracts', () => {
    it('returns empty array when no contracts exist', async () => {
      const res = await request(app).get('/api/contracts');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('returns a summary entry for each registered service', async () => {
      await request(app)
        .post('/api/contracts/svc-a/1.0.0')
        .set('Content-Type', 'application/json')
        .send(SPEC_V1);
      await request(app)
        .post('/api/contracts/svc-b/2.0.0')
        .set('Content-Type', 'application/json')
        .send(SPEC_V2);
      const res = await request(app).get('/api/contracts');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      const names = res.body.map((s: { serviceName: string }) => s.serviceName);
      expect(names).toContain('svc-a');
      expect(names).toContain('svc-b');
    });
  });

  // ── GET /api/compatibility/:provider/:consumer ────────────────────────

  describe('GET /api/compatibility/:provider/:consumer', () => {
    it('returns 404 when provider is not registered', async () => {
      const res = await request(app).get('/api/compatibility/unknown-provider/consumer');
      expect(res.status).toBe(404);
    });

    it('returns 404 when consumer is not registered', async () => {
      await request(app)
        .post('/api/contracts/provider/1.0.0')
        .set('Content-Type', 'application/json')
        .send(SPEC_V1);
      const res = await request(app).get('/api/compatibility/provider/unknown-consumer');
      expect(res.status).toBe(404);
    });

    it('returns 200 compatible:true when all consumer paths exist in provider', async () => {
      // Consumer uses only /hello which provider also has
      const consumerSpec = JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'Consumer', version: '1.0.0' },
        paths: { '/hello': { get: { responses: { '200': { description: 'OK' } } } } },
      });
      await request(app)
        .post('/api/contracts/provider/1.0.0')
        .set('Content-Type', 'application/json')
        .send(SPEC_V1);
      await request(app)
        .post('/api/contracts/consumer/1.0.0')
        .set('Content-Type', 'application/json')
        .send(consumerSpec);
      const res = await request(app).get('/api/compatibility/provider/consumer');
      expect(res.status).toBe(200);
      expect(res.body.compatible).toBe(true);
      expect(res.body.missingPaths).toEqual([]);
    });

    it('returns 409 compatible:false when consumer needs paths provider dropped', async () => {
      // v2 of provider dropped /health; consumer still needs it
      const consumerSpec = JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'Consumer', version: '1.0.0' },
        paths: {
          '/hello':  { get: { responses: { '200': { description: 'OK' } } } },
          '/health': { get: { responses: { '200': { description: 'OK' } } } },
        },
      });
      await request(app)
        .post('/api/contracts/provider/2.0.0')
        .set('Content-Type', 'application/json')
        .send(SPEC_V2); // v2 only has /hello
      await request(app)
        .post('/api/contracts/consumer/1.0.0')
        .set('Content-Type', 'application/json')
        .send(consumerSpec);
      const res = await request(app).get('/api/compatibility/provider/consumer');
      expect(res.status).toBe(409);
      expect(res.body.compatible).toBe(false);
      expect(res.body.missingPaths).toContain('/health');
    });
  });

  // ── POST /api/breaking-changes ────────────────────────────────────────

  describe('POST /api/breaking-changes', () => {
    it('returns 404 when from_version is not registered', async () => {
      const res = await request(app)
        .post('/api/breaking-changes')
        .set('Content-Type', 'application/json')
        .send({ service_name: 'hello-service', from_version: '0.0.1', to_version: '1.0.0' });
      expect(res.status).toBe(404);
    });

    it('returns 200 with empty breaking array for identical versions', async () => {
      await request(app)
        .post('/api/contracts/hello-service/1.0.0')
        .set('Content-Type', 'application/json')
        .send(SPEC_V1);
      const res = await request(app)
        .post('/api/breaking-changes')
        .set('Content-Type', 'application/json')
        .send({ service_name: 'hello-service', from_version: '1.0.0', to_version: '1.0.0' });
      expect(res.status).toBe(200);
      expect(res.body.breaking).toEqual([]);
    });

    it('returns 422 when breaking changes are detected', async () => {
      await request(app)
        .post('/api/contracts/hello-service/1.0.0')
        .set('Content-Type', 'application/json')
        .send(SPEC_V1);
      await request(app)
        .post('/api/contracts/hello-service/2.0.0')
        .set('Content-Type', 'application/json')
        .send(SPEC_V2); // dropped /health
      const res = await request(app)
        .post('/api/breaking-changes')
        .set('Content-Type', 'application/json')
        .send({ service_name: 'hello-service', from_version: '1.0.0', to_version: '2.0.0' });
      expect(res.status).toBe(422);
      expect(res.body.breaking.length).toBeGreaterThan(0);
      // Each breaking change is an object { type, path, detail }.
      const mentionsHealth = res.body.breaking.some(
        (b: { detail?: string; path?: string }) => (b.detail ?? b.path ?? '').includes('/health'),
      );
      expect(mentionsHealth).toBe(true);
    });

    it('includes service and version info in the response', async () => {
      await request(app)
        .post('/api/contracts/hello-service/1.0.0')
        .set('Content-Type', 'application/json')
        .send(SPEC_V1);
      const res = await request(app)
        .post('/api/breaking-changes')
        .set('Content-Type', 'application/json')
        .send({ service_name: 'hello-service', from_version: '1.0.0', to_version: '1.0.0' });
      expect(res.body.service).toBe('hello-service');
      expect(res.body.from_version).toBe('1.0.0');
      expect(res.body.to_version).toBe('1.0.0');
    });

    it('returns 404 when to_version is not registered', async () => {
      await request(app)
        .post('/api/contracts/hello-service/1.0.0')
        .set('Content-Type', 'application/json')
        .send(SPEC_V1);
      const res = await request(app)
        .post('/api/breaking-changes')
        .set('Content-Type', 'application/json')
        .send({ service_name: 'hello-service', from_version: '1.0.0', to_version: '99.0.0' });
      expect(res.status).toBe(404);
    });
  });

  // ── GET /api/can-i-deploy/:service/:version ─────────────────────────────

  describe('GET /api/can-i-deploy/:service/:version', () => {
    it('returns 404 when the target version is not registered', async () => {
      const res = await request(app).get('/api/can-i-deploy/hello-service/9.9.9');
      expect(res.status).toBe(404);
    });

    it('returns 200 safe:true when no consumers are blocked and no breaking changes vs current', async () => {
      await request(app)
        .post('/api/contracts/hello-service/1.0.0')
        .set('Content-Type', 'application/json')
        .send(SPEC_V1);
      const res = await request(app).get('/api/can-i-deploy/hello-service/1.0.0');
      expect(res.status).toBe(200);
      expect(res.body.safe).toBe(true);
      expect(res.body.blockingConsumers).toEqual([]);
    });

    it('returns 409 safe:false when a registered consumer needs a path the target version dropped', async () => {
      const consumerSpec = JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'Consumer', version: '1.0.0' },
        paths: { '/health': { get: { responses: { '200': { description: 'OK' } } } } },
      });
      await request(app)
        .post('/api/contracts/hello-service/1.0.0')
        .set('Content-Type', 'application/json')
        .send(SPEC_V1);
      await request(app)
        .post('/api/contracts/hello-service/2.0.0')
        .set('Content-Type', 'application/json')
        .send(SPEC_V2); // dropped /health
      await request(app)
        .post('/api/contracts/consumer/1.0.0')
        .set('Content-Type', 'application/json')
        .send(consumerSpec);
      const res = await request(app).get('/api/can-i-deploy/hello-service/2.0.0');
      expect(res.status).toBe(409);
      expect(res.body.safe).toBe(false);
      expect(res.body.blockingConsumers.length).toBeGreaterThan(0);
      expect(res.body.breakingChanges.length).toBeGreaterThan(0);
    });
  });

  // ── GET /api/stale-contracts ────────────────────────────────────────────

  describe('GET /api/stale-contracts', () => {
    it('returns empty when no contracts are stale', async () => {
      await request(app)
        .post('/api/contracts/hello-service/1.0.0')
        .set('Content-Type', 'application/json')
        .send(SPEC_V1);
      const res = await request(app).get('/api/stale-contracts?days=30');
      expect(res.status).toBe(200);
      expect(res.body.staleCount).toBe(0);
    });

    it('flags a contract as stale when threshold is 0 days', async () => {
      await request(app)
        .post('/api/contracts/hello-service/1.0.0')
        .set('Content-Type', 'application/json')
        .send(SPEC_V1);
      const res = await request(app).get('/api/stale-contracts?days=0');
      expect(res.status).toBe(200);
      expect(res.body.staleCount).toBe(1);
      expect(res.body.services[0].serviceName).toBe('hello-service');
    });
  });

  // ── GET /api/audit ───────────────────────────────────────────────────────

  describe('GET /api/audit', () => {
    it('returns an empty list when no events have been recorded for the filter', async () => {
      const res = await request(app).get('/api/audit?service=never-called-service');
      expect(res.status).toBe(200);
      expect(res.body.events).toEqual([]);
    });
  });

  // ── POST /api/migration-guide ────────────────────────────────────────────

  describe('POST /api/migration-guide', () => {
    it('returns 404 when from_version is not registered', async () => {
      const res = await request(app)
        .post('/api/migration-guide')
        .set('Content-Type', 'application/json')
        .send({ service_name: 'hello-service', from_version: '0.0.1', to_version: '1.0.0' });
      expect(res.status).toBe(404);
    });

    it('returns markdown describing breaking changes and affected consumers', async () => {
      const consumerSpec = JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'Consumer', version: '1.0.0' },
        paths: { '/health': { get: { responses: { '200': { description: 'OK' } } } } },
      });
      await request(app)
        .post('/api/contracts/hello-service/1.0.0')
        .set('Content-Type', 'application/json')
        .send(SPEC_V1);
      await request(app)
        .post('/api/contracts/hello-service/2.0.0')
        .set('Content-Type', 'application/json')
        .send(SPEC_V2);
      await request(app)
        .post('/api/contracts/consumer/1.0.0')
        .set('Content-Type', 'application/json')
        .send(consumerSpec);
      const res = await request(app)
        .post('/api/migration-guide')
        .set('Content-Type', 'application/json')
        .send({ service_name: 'hello-service', from_version: '1.0.0', to_version: '2.0.0' });
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/markdown');
      expect(res.text).toContain('Migration Guide');
      expect(res.text).toContain('consumer');
    });
  });
});

// ── Store error paths (500 responses) ────────────────────────────────────────
// These cover the catch blocks in app.ts when the store itself throws.

import { type ContractStore, type ContractEntry, type StoreSummary } from '../store.js';

const brokenStore: ContractStore = {
  register:     async () => { throw new Error('DB connection lost'); },
  getLatest:    async () => { throw new Error('DB connection lost'); },
  getByVersion: async () => { throw new Error('DB connection lost'); },
  listAll:      async () => { throw new Error('DB connection lost'); },
};

describe('REST API — store error paths', () => {
  const errApp = createApp(brokenStore);

  it('GET /api/contracts/:service → 500 when store throws', async () => {
    const res = await request(errApp).get('/api/contracts/svc');
    expect(res.status).toBe(500);
    expect(res.body.error).toContain('DB connection lost');
  });

  it('GET /api/contracts → 500 when store throws', async () => {
    const res = await request(errApp).get('/api/contracts');
    expect(res.status).toBe(500);
    expect(res.body.error).toContain('DB connection lost');
  });

  it('GET /api/compatibility/:provider/:consumer → 500 when store throws', async () => {
    const res = await request(errApp).get('/api/compatibility/provider/consumer');
    expect(res.status).toBe(500);
    expect(res.body.error).toContain('DB connection lost');
  });

  it('POST /api/breaking-changes → 500 when store throws', async () => {
    const res = await request(errApp)
      .post('/api/breaking-changes')
      .set('Content-Type', 'application/json')
      .send({ service_name: 'svc', from_version: '1.0.0', to_version: '2.0.0' });
    expect(res.status).toBe(500);
    expect(res.body.error).toContain('DB connection lost');
  });
});

// ── Partial-store stubs for compatibility edge cases ──────────────────────────

function makeStub(overrides: Partial<ContractStore>): ContractStore {
  return {
    register:     async () => { throw new Error('not used'); },
    getLatest:    async () => undefined,
    getByVersion: async () => undefined,
    listAll:      async () => [],
    ...overrides,
  };
}

describe('REST API — compatibility edge cases', () => {
  it('returns 409 with empty missingPaths array when services are compatible', async () => {
    // Provider and consumer have the same single path.
    const entry: ContractEntry = {
      version: '1.0.0',
      specJson: SPEC_V1,
      timestamp: new Date().toISOString(),
      paths: ['/hello'],
    };
    const stub = makeStub({ getLatest: async () => entry });
    const res = await request(createApp(stub)).get('/api/compatibility/provider/consumer');
    expect(res.status).toBe(200);
    expect(res.body.compatible).toBe(true);
    expect(res.body.missingPaths).toEqual([]);
  });
});
