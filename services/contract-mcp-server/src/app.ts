import express from 'express';
import { type ContractStore } from './store.js';
import { parseSpec, detectBreakingChanges, generateMigrationGuide, type AffectedConsumer, type BreakingChange } from './generator.js';
import { getAuditLog } from './audit.js';

// ── Service registry helpers ──────────────────────────────────────────────
// Exported so unit tests can cover them without starting a server.

export function parseServicesRegistry(raw = process.env.SERVICES_REGISTRY ?? ''): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw) return map;
  for (const pair of raw.split(',')) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx < 1) continue;
    const name = pair.slice(0, eqIdx).trim();
    const url  = pair.slice(eqIdx + 1).trim();
    if (name && url) map.set(name, url);
  }
  return map;
}

export function resolveServiceBaseUrl(
  serviceName: string,
  namespace: string,
  port: number,
  mode = (process.env.DISCOVERY_MODE ?? 'kubernetes').toLowerCase(),
): string {
  if (mode === 'http') {
    const registry = parseServicesRegistry();
    const url = registry.get(serviceName);
    if (!url) throw new Error(`Service "${serviceName}" not found in SERVICES_REGISTRY. Format: name1=http://url1,name2=http://url2`);
    return url.replace(/\/$/, '');
  }
  return `http://${serviceName}.${namespace}.svc.cluster.local:${port}`;
}

// A consumer is affected either because a path it depends on disappeared
// entirely (missingPaths), or because a path+method it depends on is still
// present but changed in an incompatible way (affectedOperations) — e.g. a
// required response field it relies on was removed or renamed. The latter
// can't be seen from path lists alone, so it's cross-referenced against the
// already-computed breaking-changes list for this exact provider transition.
export async function findAffectedConsumers(
  store: ContractStore,
  providerName: string,
  newPaths: string[],
  breaking: BreakingChange[] = [],
): Promise<AffectedConsumer[]> {
  const providerPathSet = new Set(newPaths);
  const breakingOps = new Set(breaking.map(b => `${(b.method ?? '').toUpperCase()} ${b.path}`));
  const allServices = await store.listAll();
  const affectedConsumers: AffectedConsumer[] = [];
  for (const svc of allServices) {
    if (svc.serviceName === providerName) continue;
    const consumer = await store.getLatest(svc.serviceName);
    if (!consumer) continue;
    const missing = consumer.paths.filter(p => !providerPathSet.has(p));
    const consumerSpec = parseSpec(consumer.specJson);
    const affectedOperations: string[] = [];
    for (const [path, methods] of Object.entries(consumerSpec.paths ?? {})) {
      for (const method of Object.keys(methods)) {
        const key = `${method.toUpperCase()} ${path}`;
        if (breakingOps.has(key)) affectedOperations.push(key);
      }
    }
    if (missing.length > 0 || affectedOperations.length > 0) {
      affectedConsumers.push({ service: svc.serviceName, missingPaths: missing, affectedOperations });
    }
  }
  return affectedConsumers;
}

// ── App factory ───────────────────────────────────────────────────────────
// Accepts an injected ContractStore so tests can pass an in-memory store
// without hitting external databases or triggering prom-client registration.

export function createApp(
  store: ContractStore,
  options: { apiKey?: string } = {},
): express.Application {
  const API_KEY = options.apiKey ?? process.env.API_KEY ?? '';
  const app = express();

  function requireApiKey(req: express.Request, res: express.Response, next: express.NextFunction): void {
    if (!API_KEY) { next(); return; }
    if (req.headers['x-api-key'] !== API_KEY) {
      res.status(401).json({ error: 'Missing or invalid X-Api-Key header' });
      return;
    }
    next();
  }

  // POST /api/contracts/:service/:version — register a contract
  app.post(
    '/api/contracts/:service/:version',
    requireApiKey,
    express.text({ type: ['application/json', 'text/plain', 'application/x-yaml', 'application/yaml'], limit: '5mb' }),
    async (req, res) => {
      try {
        const { service, version } = req.params;
        const spec = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
        const entry = await store.register(service, version, spec);
        res.json({ registered: true, service, version, pathCount: entry.paths.length, timestamp: entry.timestamp });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // GET /api/contracts/:service — retrieve latest (or ?version=) contract
  app.get('/api/contracts/:service', async (req, res) => {
    try {
      const { service } = req.params;
      const version = typeof req.query['version'] === 'string' ? req.query['version'] : undefined;
      const entry = version ? await store.getByVersion(service, version) : await store.getLatest(service);
      if (!entry) {
        res.status(404).json({ error: `No contract for "${service}"${version ? ` v${version}` : ''}` });
        return;
      }
      res.json({ service, version: entry.version, timestamp: entry.timestamp, paths: entry.paths, spec: JSON.parse(entry.specJson) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/contracts — list all registered contracts
  app.get('/api/contracts', async (_req, res) => {
    try {
      res.json(await store.listAll());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/compatibility/:provider/:consumer — check compatibility
  app.get('/api/compatibility/:provider/:consumer', async (req, res) => {
    try {
      const { provider, consumer } = req.params;
      const providerEntry = await store.getLatest(provider);
      const consumerEntry = await store.getLatest(consumer);
      if (!providerEntry) { res.status(404).json({ error: `Provider "${provider}" not registered` }); return; }
      if (!consumerEntry) { res.status(404).json({ error: `Consumer "${consumer}" not registered` }); return; }
      const providerPaths = new Set(providerEntry.paths);
      const missingPaths  = consumerEntry.paths.filter(p => !providerPaths.has(p));
      const compatible    = missingPaths.length === 0;
      res.status(compatible ? 200 : 409).json({ compatible, provider, consumer, missingPaths });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/breaking-changes — { service_name, from_version, to_version }
  app.post('/api/breaking-changes', express.json(), async (req, res) => {
    try {
      const { service_name, from_version, to_version } = req.body as { service_name: string; from_version: string; to_version: string };
      const fromEntry = await store.getByVersion(service_name, from_version);
      const toEntry   = await store.getByVersion(service_name, to_version);
      if (!fromEntry) { res.status(404).json({ error: `Version ${from_version} of "${service_name}" not found` }); return; }
      if (!toEntry)   { res.status(404).json({ error: `Version ${to_version} of "${service_name}" not found` }); return; }
      const result = detectBreakingChanges(parseSpec(fromEntry.specJson), parseSpec(toEntry.specJson));
      res.status(result.breaking.length > 0 ? 422 : 200).json({ service: service_name, from_version, to_version, ...result });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/can-i-deploy/:service/:version — deploy-time compatibility gate
  app.get('/api/can-i-deploy/:service/:version', async (req, res) => {
    try {
      const { service, version } = req.params;
      const target = await store.getByVersion(service, version);
      if (!target) { res.status(404).json({ error: `Version ${version} of "${service}" not registered` }); return; }
      const summary = (await store.listAll()).find(s => s.serviceName === service);
      const idx = summary?.versions.indexOf(version) ?? -1;
      const previousVersion = idx > 0 ? summary!.versions[idx - 1] : undefined;
      const previousEntry = previousVersion ? await store.getByVersion(service, previousVersion) : undefined;
      const breakingChanges = previousEntry
        ? detectBreakingChanges(parseSpec(previousEntry.specJson), parseSpec(target.specJson)).breaking
        : [];
      const affected = await findAffectedConsumers(store, service, target.paths, breakingChanges);
      const blockingConsumers = await Promise.all(affected.map(async a => {
        const consumerEntry = await store.getLatest(a.service);
        return { consumer: a.service, consumerVersion: consumerEntry!.version, missingPaths: a.missingPaths, affectedOperations: a.affectedOperations ?? [] };
      }));
      const safe = blockingConsumers.length === 0 && breakingChanges.length === 0;
      res.status(safe ? 200 : 409).json({ safe, service, version, previousVersion: previousVersion ?? null, blockingConsumers, breakingChanges });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/stale-contracts?days= — contracts not updated within the threshold
  app.get('/api/stale-contracts', async (req, res) => {
    try {
      const days = typeof req.query['days'] === 'string' ? parseInt(req.query['days'], 10) : parseInt(process.env.STALE_THRESHOLD_DAYS ?? '30', 10);
      const all = await store.listAll();
      const now = Date.now();
      const stale = all
        .map(s => ({ ...s, ageDays: s.registeredAt ? Math.floor((now - new Date(s.registeredAt).getTime()) / 86400000) : null }))
        .filter(s => s.ageDays !== null && s.ageDays >= days);
      res.json({ thresholdDays: days, staleCount: stale.length, services: stale });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/audit?service=&action=&agent=&limit= — query usage/audit events
  app.get('/api/audit', (req, res) => {
    const { service, action, agent } = req.query;
    const limit = typeof req.query['limit'] === 'string' ? parseInt(req.query['limit'], 10) : undefined;
    const events = getAuditLog({
      service: typeof service === 'string' ? service : undefined,
      action: typeof action === 'string' ? action : undefined,
      agent: typeof agent === 'string' ? agent : undefined,
      limit,
    });
    res.json({ count: events.length, events });
  });

  // POST /api/migration-guide — { service_name, from_version, to_version }
  app.post('/api/migration-guide', express.json(), async (req, res) => {
    try {
      const { service_name, from_version, to_version } = req.body as { service_name: string; from_version: string; to_version: string };
      const fromEntry = await store.getByVersion(service_name, from_version);
      const toEntry = await store.getByVersion(service_name, to_version);
      if (!fromEntry) { res.status(404).json({ error: `Version ${from_version} of "${service_name}" not found` }); return; }
      if (!toEntry) { res.status(404).json({ error: `Version ${to_version} of "${service_name}" not found` }); return; }
      const { breaking } = detectBreakingChanges(parseSpec(fromEntry.specJson), parseSpec(toEntry.specJson));
      const affectedConsumers = await findAffectedConsumers(store, service_name, toEntry.paths, breaking);
      const guide = generateMigrationGuide(service_name, from_version, to_version, breaking, affectedConsumers);
      res.set('Content-Type', 'text/markdown').send(guide);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return app;
}
