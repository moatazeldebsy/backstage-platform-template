import { createStore } from '../store.js';

const OPENAPI_SPEC = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Test Service', version: '1.0.0' },
  paths: {
    '/healthz': { get: { responses: { '200': { description: 'OK' } } } },
    '/api/users': { get: { responses: { '200': { description: 'OK' } } } },
  },
});

const OPENAPI_SPEC_V2 = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Test Service', version: '2.0.0' },
  paths: {
    '/api/v2/users': { get: { responses: { '200': { description: 'OK' } } } },
  },
});

describe('InMemoryStore', () => {
  let store: Awaited<ReturnType<typeof createStore>>;

  beforeEach(async () => {
    process.env.STORAGE_TYPE = 'memory';
    store = await createStore();
  });

  describe('register', () => {
    it('stores a contract and returns an entry', async () => {
      const entry = await store.register('svc-a', '1.0.0', OPENAPI_SPEC);
      expect(entry.version).toBe('1.0.0');
      expect(entry.paths).toContain('/healthz');
      expect(entry.paths).toContain('/api/users');
      expect(entry.timestamp).toBeTruthy();
    });

    it('extracts all paths from the spec', async () => {
      const entry = await store.register('svc-b', '1.0.0', OPENAPI_SPEC);
      expect(entry.paths).toHaveLength(2);
    });

    it('upserts when the same version is registered again', async () => {
      await store.register('svc-c', '1.0.0', OPENAPI_SPEC);
      const updated = await store.register('svc-c', '1.0.0', OPENAPI_SPEC_V2);
      expect(updated.paths).toContain('/api/v2/users');

      const latest = await store.getLatest('svc-c');
      expect(latest?.paths).toContain('/api/v2/users');
    });

    it('stores multiple versions independently', async () => {
      await store.register('svc-d', '1.0.0', OPENAPI_SPEC);
      await store.register('svc-d', '2.0.0', OPENAPI_SPEC_V2);

      const v1 = await store.getByVersion('svc-d', '1.0.0');
      const v2 = await store.getByVersion('svc-d', '2.0.0');
      expect(v1?.paths).toContain('/healthz');
      expect(v2?.paths).toContain('/api/v2/users');
    });
  });

  describe('getLatest', () => {
    it('returns undefined for an unknown service', async () => {
      const result = await store.getLatest('nonexistent');
      expect(result).toBeUndefined();
    });

    it('returns the most recently registered version', async () => {
      await store.register('svc-e', '1.0.0', OPENAPI_SPEC);
      await store.register('svc-e', '2.0.0', OPENAPI_SPEC_V2);
      const latest = await store.getLatest('svc-e');
      expect(latest?.version).toBe('2.0.0');
    });

    it('persists the raw spec JSON', async () => {
      await store.register('svc-f', '1.0.0', OPENAPI_SPEC);
      const entry = await store.getLatest('svc-f');
      expect(JSON.parse(entry!.specJson).info.title).toBe('Test Service');
    });
  });

  describe('getByVersion', () => {
    it('returns undefined for unknown version', async () => {
      await store.register('svc-g', '1.0.0', OPENAPI_SPEC);
      const result = await store.getByVersion('svc-g', '9.9.9');
      expect(result).toBeUndefined();
    });

    it('retrieves a specific version by name', async () => {
      await store.register('svc-h', '1.0.0', OPENAPI_SPEC);
      await store.register('svc-h', '2.0.0', OPENAPI_SPEC_V2);
      const v1 = await store.getByVersion('svc-h', '1.0.0');
      expect(v1?.version).toBe('1.0.0');
      expect(v1?.paths).toContain('/healthz');
    });
  });

  describe('listAll', () => {
    it('returns empty array when nothing is registered', async () => {
      const all = await store.listAll();
      expect(all).toEqual([]);
    });

    it('returns all registered services', async () => {
      await store.register('alpha', '1.0.0', OPENAPI_SPEC);
      await store.register('beta', '1.0.0', OPENAPI_SPEC);
      const all = await store.listAll();
      const names = all.map(s => s.serviceName);
      expect(names).toContain('alpha');
      expect(names).toContain('beta');
    });

    it('includes all versions for a service', async () => {
      await store.register('gamma', '1.0.0', OPENAPI_SPEC);
      await store.register('gamma', '2.0.0', OPENAPI_SPEC_V2);
      const all = await store.listAll();
      const gamma = all.find(s => s.serviceName === 'gamma');
      expect(gamma?.versions).toEqual(expect.arrayContaining(['1.0.0', '2.0.0']));
      expect(gamma?.latestVersion).toBe('2.0.0');
    });

    it('each summary has registeredAt timestamp', async () => {
      await store.register('delta', '1.0.0', OPENAPI_SPEC);
      const all = await store.listAll();
      expect(all[0].registeredAt).toBeTruthy();
    });
  });
});
