import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { register, collectDefaultMetrics, Counter, Histogram } from 'prom-client';
import { createStore, type ContractStore } from './store.js';
import { parseSpec, generatePactJson, generatePactTestCode, detectBreakingChanges, extractSchemaContext, generateMigrationGuide } from './generator.js';
import { createApp, parseServicesRegistry, resolveServiceBaseUrl, findAffectedConsumers } from './app.js';
import { auditLog, getAuditLog } from './audit.js';

const PORT = parseInt(process.env.PORT ?? '3003', 10);
const K8S_API = process.env.K8S_API ?? 'https://kubernetes.default.svc';
const K8S_TOKEN = process.env.K8S_TOKEN ?? '';
const HTTP_TIMEOUT_MS = parseInt(process.env.HTTP_TIMEOUT_MS ?? '8000', 10);
const DISCOVER_PROBE_TIMEOUT_MS = parseInt(process.env.DISCOVER_PROBE_TIMEOUT_MS ?? '2500', 10);
const DISCOVER_CONCURRENCY = parseInt(process.env.DISCOVER_CONCURRENCY ?? '10', 10);
const DISCOVERY_MODE = (process.env.DISCOVERY_MODE ?? 'kubernetes').toLowerCase();
const BREAKING_CHANGE_WEBHOOK_URL = process.env.BREAKING_CHANGE_WEBHOOK_URL ?? '';
const API_KEY = process.env.API_KEY ?? '';

// Service-account token is read once at boot; kubelet rotates the file
// in-place, so re-reading per request just adds blocking I/O on the hot path.
const SA_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';
let cachedSaToken = '';
try {
  if (fs.existsSync(SA_TOKEN_PATH)) {
    cachedSaToken = fs.readFileSync(SA_TOKEN_PATH, 'utf8').trim();
    fs.watch(SA_TOKEN_PATH, { persistent: false }, () => {
      try { cachedSaToken = fs.readFileSync(SA_TOKEN_PATH, 'utf8').trim(); } catch { /* keep last good token */ }
    });
  }
} catch { /* not running in-cluster; K8S_TOKEN env var used instead */ }

// ── HTTP helpers ──────────────────────────────────────────────────────────

async function fetchWithTimeout(url: string, timeoutMs: number = HTTP_TIMEOUT_MS, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

async function fetchK8s(path: string) {
  const token = K8S_TOKEN || cachedSaToken;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetchWithTimeout(`${K8S_API}${path}`, HTTP_TIMEOUT_MS, { headers } as RequestInit);
  if (!res.ok) throw new Error(`K8s API error ${res.status} at ${path}`);
  return res.json() as Promise<{ items: Array<Record<string, unknown>> }>;
}

// Docker Engine API via unix socket (DISCOVERY_MODE=docker)
function fetchDocker(apiPath: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socketPath = (process.env.DOCKER_HOST ?? '').replace('unix://', '') || '/var/run/docker.sock';
    const req = http.request({ socketPath, path: apiPath, method: 'GET' }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk as string; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Metrics ───────────────────────────────────────────────────────────────

collectDefaultMetrics();
const SERVER_NAME = 'contract-mcp-server';
const toolCalls = new Counter({ name: 'mcp_tool_calls_total', help: 'Total MCP tool calls', labelNames: ['server', 'tool', 'outcome'] });
const toolDuration = new Histogram({ name: 'mcp_tool_duration_seconds', help: 'MCP tool call duration', labelNames: ['server', 'tool'] });
const agentToolCalls = new Counter({ name: 'mcp_agent_tool_calls_total', help: 'Tool calls attributed per calling agent', labelNames: ['server', 'tool', 'agent'] });

// ── Async initialisation (top-level await — ESM) ──────────────────────────

const store: ContractStore = await createStore();

// ── Breaking-change webhook (fire-and-forget) ─────────────────────────────

async function fireBreakingChangeWebhook(
  providerName: string,
  previousVersion: string,
  newVersion: string,
  previousPaths: string[],
  newPaths: string[],
  previousSpecJson: string,
  newSpecJson: string,
): Promise<void> {
  if (!BREAKING_CHANGE_WEBHOOK_URL) return;
  try {
    const { breaking } = detectBreakingChanges(parseSpec(previousSpecJson), parseSpec(newSpecJson));
    if (breaking.length === 0) return;

    const affectedConsumers = await findAffectedConsumers(store, providerName, newPaths);

    await fetchWithTimeout(BREAKING_CHANGE_WEBHOOK_URL, 10000, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: providerName,
        from_version: previousVersion,
        to_version: newVersion,
        breaking_changes: breaking,
        affected_consumers: affectedConsumers,
        timestamp: new Date().toISOString(),
      }),
    } as RequestInit);
  } catch (err) {
    console.error('Breaking-change webhook delivery failed:', err);
  }
}

// ── OpenAPI spec fetching helpers (multi-mode discovery) ──────────────────

async function probeServiceForSpec(
  serviceName: string,
  baseUrl: string,
  tryPaths: string[],
  timeoutMs = DISCOVER_PROBE_TIMEOUT_MS,
): Promise<{ specText: string; fetchedPath: string } | null> {
  for (const p of tryPaths) {
    try {
      const res = await fetchWithTimeout(`${baseUrl}${p}`, timeoutMs);
      if (res.ok) return { specText: await res.text(), fetchedPath: p };
    } catch { /* try next */ }
  }
  return null;
}

// ── MCP server factory (stateless — fresh instance per request) ──────────

function createServer(agentId: string = 'unknown') {
  const server = new McpServer({ name: 'contract-mcp-server', version: '2.0.0' });

  // ── register_contract ────────────────────────────────────────────────────

  server.tool(
    'register_contract',
    'Register or update an OpenAPI spec for a service. The spec can be JSON or YAML string. ' +
    'Call this whenever a service\'s API spec changes to keep the contract registry current. ' +
    'Automatically detects breaking changes vs the previous version and fires a webhook if BREAKING_CHANGE_WEBHOOK_URL is configured.',
    {
      service_name: z.string().describe('Service name (e.g. payments-api, hello-service)'),
      version: z.string().describe('Semver version string, e.g. 1.0.0 or 2.1.0'),
      openapi_spec: z.string().describe('Full OpenAPI 3.x spec as a JSON or YAML string'),
    },
    async ({ service_name, version, openapi_spec }) => {
      const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'register_contract' });
      agentToolCalls.inc({ server: SERVER_NAME, tool: 'register_contract', agent: agentId });
      let outcome = 'success';
      auditLog({ action: 'register_contract_requested', agent: agentId, service: service_name, version });
      try {
        const previous = await store.getLatest(service_name);
        const entry = await store.register(service_name, version, openapi_spec);

        // Fire breaking-change webhook asynchronously (never blocks the MCP response)
        if (previous && previous.version !== version) {
          void fireBreakingChangeWebhook(
            service_name, previous.version, version,
            previous.paths, entry.paths,
            previous.specJson, entry.specJson,
          );
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              registered: true,
              serviceName: service_name,
              version,
              pathCount: entry.paths.length,
              paths: entry.paths,
              timestamp: entry.timestamp,
              previousVersion: previous?.version ?? null,
            }, null, 2),
          }],
        };
      } catch (err) {
        outcome = 'error';
        throw err;
      } finally {
        end();
        toolCalls.inc({ server: SERVER_NAME, tool: 'register_contract', outcome });
      }
    },
  );

  // ── get_contract ─────────────────────────────────────────────────────────

  server.tool(
    'get_contract',
    'Retrieve a registered OpenAPI contract for a service. Returns the latest version by default.',
    {
      service_name: z.string().describe('Service name to look up'),
      version: z.string().optional().describe('Specific version to retrieve (default: latest)'),
    },
    async ({ service_name, version }) => {
      const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'get_contract' });
      agentToolCalls.inc({ server: SERVER_NAME, tool: 'get_contract', agent: agentId });
      let outcome = 'success';
      auditLog({ action: 'get_contract', agent: agentId, service: service_name, version });
      try {
        const entry = version ? await store.getByVersion(service_name, version) : await store.getLatest(service_name);
        if (!entry) {
          return { content: [{ type: 'text' as const, text: `No contract found for service "${service_name}"${version ? ` version ${version}` : ''}. Register one first with register_contract.` }] };
        }
        const spec = parseSpec(entry.specJson);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              serviceName: service_name,
              version: entry.version,
              timestamp: entry.timestamp,
              paths: entry.paths,
              schemas: extractSchemaContext(spec),
              spec,
            }, null, 2),
          }],
        };
      } catch (err) {
        outcome = 'error';
        throw err;
      } finally {
        end();
        toolCalls.inc({ server: SERVER_NAME, tool: 'get_contract', outcome });
      }
    },
  );

  // ── list_contracts ───────────────────────────────────────────────────────

  server.tool(
    'list_contracts',
    'List all services that have registered contracts, with their available versions.',
    {},
    async () => {
      const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'list_contracts' });
      agentToolCalls.inc({ server: SERVER_NAME, tool: 'list_contracts', agent: agentId });
      let outcome = 'success';
      auditLog({ action: 'list_contracts', agent: agentId });
      try {
        const all = await store.listAll();
        return {
          content: [{
            type: 'text' as const,
            text: all.length === 0
              ? 'No contracts registered yet. Use register_contract to add a service spec.'
              : JSON.stringify(all, null, 2),
          }],
        };
      } catch (err) {
        outcome = 'error';
        throw err;
      } finally {
        end();
        toolCalls.inc({ server: SERVER_NAME, tool: 'list_contracts', outcome });
      }
    },
  );

  // ── generate_contract_tests ──────────────────────────────────────────────

  server.tool(
    'generate_contract_tests',
    'Generate Pact consumer-driven contract tests from a registered provider spec. ' +
    'Returns both the Pact JSON (for broker publishing) and TypeScript test code.',
    {
      service_name: z.string().describe('Provider service name (must have a registered contract)'),
      consumer_name: z.string().describe('Name of the consumer service that will call this provider'),
      version: z.string().optional().describe('Provider spec version to generate from (default: latest)'),
    },
    async ({ service_name, consumer_name, version }) => {
      const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'generate_contract_tests' });
      agentToolCalls.inc({ server: SERVER_NAME, tool: 'generate_contract_tests', agent: agentId });
      let outcome = 'success';
      auditLog({ action: 'generate_contract_tests', agent: agentId, service: service_name, consumer: consumer_name });
      try {
        const entry = version ? await store.getByVersion(service_name, version) : await store.getLatest(service_name);
        if (!entry) {
          return { content: [{ type: 'text' as const, text: `No contract found for provider "${service_name}". Register it first with register_contract.` }] };
        }
        const spec = parseSpec(entry.specJson);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              provider: service_name, consumer: consumer_name, specVersion: entry.version,
              pactJson: generatePactJson(consumer_name, service_name, spec),
              testCode: generatePactTestCode(consumer_name, service_name, spec),
              instructions: [
                `Save pactJson to ./pacts/${consumer_name}-${service_name}.json`,
                `Save testCode to ./tests/${consumer_name}-${service_name}.pact.spec.ts`,
                'Run: npm test to verify the consumer tests pass',
              ],
            }, null, 2),
          }],
        };
      } catch (err) {
        outcome = 'error';
        throw err;
      } finally {
        end();
        toolCalls.inc({ server: SERVER_NAME, tool: 'generate_contract_tests', outcome });
      }
    },
  );

  // ── validate_compatibility ───────────────────────────────────────────────

  server.tool(
    'validate_compatibility',
    'Check if a provider\'s current spec satisfies all the paths expected by a consumer. ' +
    'Both services must have registered contracts. Returns pass/fail with details.',
    {
      provider_name: z.string().describe('Provider service name'),
      consumer_name: z.string().describe('Consumer service name (must also have a registered spec)'),
    },
    async ({ provider_name, consumer_name }) => {
      const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'validate_compatibility' });
      agentToolCalls.inc({ server: SERVER_NAME, tool: 'validate_compatibility', agent: agentId });
      let outcome = 'success';
      auditLog({ action: 'validate_compatibility', agent: agentId, service: provider_name, consumer: consumer_name });
      try {
        const providerEntry = await store.getLatest(provider_name);
        const consumerEntry = await store.getLatest(consumer_name);
        if (!providerEntry) return { content: [{ type: 'text' as const, text: `Provider "${provider_name}" has no registered contract.` }] };
        if (!consumerEntry) return { content: [{ type: 'text' as const, text: `Consumer "${consumer_name}" has no registered contract. Register its expected API paths.` }] };
        const providerPaths = new Set(providerEntry.paths);
        const missingPaths = consumerEntry.paths.filter(p => !providerPaths.has(p));
        const compatible = missingPaths.length === 0;
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              compatible,
              provider: { name: provider_name, version: providerEntry.version, pathCount: providerEntry.paths.length },
              consumer: { name: consumer_name, version: consumerEntry.version, pathCount: consumerEntry.paths.length },
              missingPaths,
              verdict: compatible
                ? `✓ COMPATIBLE — ${provider_name} satisfies all ${consumerEntry.paths.length} paths expected by ${consumer_name}`
                : `✗ INCOMPATIBLE — ${provider_name} is missing ${missingPaths.length} path(s) expected by ${consumer_name}`,
            }, null, 2),
          }],
        };
      } catch (err) {
        outcome = 'error';
        throw err;
      } finally {
        end();
        toolCalls.inc({ server: SERVER_NAME, tool: 'validate_compatibility', outcome });
      }
    },
  );

  // ── detect_breaking_changes ──────────────────────────────────────────────

  server.tool(
    'detect_breaking_changes',
    'Compare two versions of a service\'s spec and identify breaking changes ' +
    '(removed paths, removed methods, new required parameters).',
    {
      service_name: z.string().describe('Service name to compare'),
      from_version: z.string().describe('The older/baseline version (e.g. 1.0.0)'),
      to_version: z.string().describe('The newer version to compare against (e.g. 2.0.0)'),
    },
    async ({ service_name, from_version, to_version }) => {
      const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'detect_breaking_changes' });
      agentToolCalls.inc({ server: SERVER_NAME, tool: 'detect_breaking_changes', agent: agentId });
      let outcome = 'success';
      auditLog({ action: 'detect_breaking_changes', agent: agentId, service: service_name, from_version, to_version });
      try {
        const fromEntry = await store.getByVersion(service_name, from_version);
        const toEntry = await store.getByVersion(service_name, to_version);
        if (!fromEntry) return { content: [{ type: 'text' as const, text: `Version ${from_version} of "${service_name}" not found.` }] };
        if (!toEntry) return { content: [{ type: 'text' as const, text: `Version ${to_version} of "${service_name}" not found.` }] };
        const result = detectBreakingChanges(parseSpec(fromEntry.specJson), parseSpec(toEntry.specJson));
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ serviceName: service_name, fromVersion: from_version, toVersion: to_version, ...result }, null, 2),
          }],
        };
      } catch (err) {
        outcome = 'error';
        throw err;
      } finally {
        end();
        toolCalls.inc({ server: SERVER_NAME, tool: 'detect_breaking_changes', outcome });
      }
    },
  );

  // ── get_compatibility_report ─────────────────────────────────────────────

  server.tool(
    'get_compatibility_report',
    'Generate a full compatibility report for a provider service: lists all registered services ' +
    'and checks whether each could be a compatible consumer of this provider.',
    { service_name: z.string().describe('Provider service name to generate the report for') },
    async ({ service_name }) => {
      const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'get_compatibility_report' });
      agentToolCalls.inc({ server: SERVER_NAME, tool: 'get_compatibility_report', agent: agentId });
      let outcome = 'success';
      auditLog({ action: 'get_compatibility_report', agent: agentId, service: service_name });
      try {
        const providerEntry = await store.getLatest(service_name);
        if (!providerEntry) return { content: [{ type: 'text' as const, text: `Provider "${service_name}" has no registered contract.` }] };
        const providerPaths = new Set(providerEntry.paths);
        const all = (await store.listAll()).filter(s => s.serviceName !== service_name);
        const report = await Promise.all(all.map(async s => {
          const consumerEntry = await store.getLatest(s.serviceName);
          if (!consumerEntry) return { consumer: s.serviceName, compatible: null, detail: 'No contract registered' };
          const missing = consumerEntry.paths.filter(p => !providerPaths.has(p));
          return {
            consumer: s.serviceName, consumerVersion: consumerEntry.version,
            compatible: missing.length === 0, missingPaths: missing,
            detail: missing.length === 0 ? 'Compatible' : `Missing: ${missing.join(', ')}`,
          };
        }));
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              provider: service_name, providerVersion: providerEntry.version,
              totalConsumers: report.length,
              compatible: report.filter(r => r.compatible === true).length,
              incompatible: report.filter(r => r.compatible === false).length,
              consumers: report,
            }, null, 2),
          }],
        };
      } catch (err) {
        outcome = 'error';
        throw err;
      } finally {
        end();
        toolCalls.inc({ server: SERVER_NAME, tool: 'get_compatibility_report', outcome });
      }
    },
  );

  // ── fetch_service_contract ───────────────────────────────────────────────

  server.tool(
    'fetch_service_contract',
    'Pull an OpenAPI spec directly from a running service and auto-register it as a contract. ' +
    'Supports DISCOVERY_MODE=kubernetes (K8s in-cluster), http (SERVICES_REGISTRY env var), or docker (Docker socket). ' +
    'The service must expose GET /openapi.json, /openapi.yaml, /api-docs, or /swagger.json.',
    {
      service_name: z.string().describe('Service name'),
      namespace: z.string().optional().describe('K8s namespace (kubernetes mode only, default: services)'),
      port: z.number().optional().describe('Service port (default: 80)'),
      openapi_path: z.string().optional().describe('Explicit path to fetch (default: auto-detect)'),
      version: z.string().optional().describe('Version label (default: taken from spec info.version)'),
    },
    async ({ service_name, namespace = 'services', port = 80, openapi_path, version }) => {
      const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'fetch_service_contract' });
      agentToolCalls.inc({ server: SERVER_NAME, tool: 'fetch_service_contract', agent: agentId });
      let outcome = 'success';
      auditLog({ action: 'fetch_service_contract', agent: agentId, service: service_name });
      try {
        let baseUrl: string;
        try {
          baseUrl = resolveServiceBaseUrl(service_name, namespace, port);
        } catch (err) {
          return { content: [{ type: 'text' as const, text: String(err instanceof Error ? err.message : err) }] };
        }

        const tryPaths = openapi_path ? [openapi_path] : ['/openapi.json', '/openapi.yaml', '/api-docs', '/swagger.json'];
        const found = await probeServiceForSpec(service_name, baseUrl, tryPaths, DISCOVER_PROBE_TIMEOUT_MS);

        if (!found) {
          return {
            content: [{
              type: 'text' as const,
              text: `No OpenAPI spec found at ${baseUrl}. Tried: ${tryPaths.join(', ')}. ` +
                'The service must expose one of these endpoints to be self-describing.',
            }],
          };
        }

        const parsed = parseSpec(found.specText);
        const specVersion = version ?? parsed.info?.version ?? new Date().toISOString().slice(0, 10);
        const entry = await store.register(service_name, specVersion, found.specText);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              discovered: true, serviceName: service_name,
              source: `${baseUrl}${found.fetchedPath}`,
              version: specVersion, title: parsed.info?.title,
              description: parsed.info?.description,
              pathCount: entry.paths.length, paths: entry.paths,
              schemas: extractSchemaContext(parsed),
              timestamp: entry.timestamp,
            }, null, 2),
          }],
        };
      } catch (err) {
        outcome = 'error';
        throw err;
      } finally {
        end();
        toolCalls.inc({ server: SERVER_NAME, tool: 'fetch_service_contract', outcome });
      }
    },
  );

  // ── auto_discover_contracts ──────────────────────────────────────────────

  server.tool(
    'auto_discover_contracts',
    'Scan all services and auto-register their OpenAPI specs. ' +
    'Supports DISCOVERY_MODE=kubernetes (scans K8s namespace), http (uses SERVICES_REGISTRY env var), ' +
    'or docker (scans running containers). Services without an OpenAPI endpoint are skipped.',
    {
      namespace: z.string().optional().describe('K8s namespace to scan (kubernetes mode only, default: services)'),
      port: z.number().optional().describe('Port to probe on each service (default: 80)'),
    },
    async ({ namespace = 'services', port = 80 }) => {
      const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'auto_discover_contracts' });
      agentToolCalls.inc({ server: SERVER_NAME, tool: 'auto_discover_contracts', agent: agentId });
      let outcome = 'success';
      auditLog({ action: 'auto_discover_contracts', agent: agentId, namespace, mode: DISCOVERY_MODE });
      try {
        type DiscoveryResult = { serviceName: string; status: 'discovered' | 'no_spec' | 'error'; version?: string; title?: string; paths?: string[]; error?: string };
        const tryPaths = ['/openapi.json', '/openapi.yaml'];

        async function probe(serviceName: string, baseUrl: string): Promise<DiscoveryResult> {
          const found = await probeServiceForSpec(serviceName, baseUrl, tryPaths, DISCOVER_PROBE_TIMEOUT_MS);
          if (!found) return { serviceName, status: 'no_spec' };
          const parsed = parseSpec(found.specText);
          const specVersion = parsed.info?.version ?? new Date().toISOString().slice(0, 10);
          const entry = await store.register(serviceName, specVersion, found.specText);
          return { serviceName, status: 'discovered', version: specVersion, title: parsed.info?.title, paths: entry.paths };
        }

        let candidates: Array<{ name: string; baseUrl: string }> = [];

        if (DISCOVERY_MODE === 'http') {
          const registry = parseServicesRegistry();
          if (registry.size === 0) {
            return { content: [{ type: 'text' as const, text: 'SERVICES_REGISTRY env var is empty. Format: name1=http://url1,name2=http://url2' }] };
          }
          candidates = Array.from(registry.entries()).map(([name, url]) => ({ name, baseUrl: url.replace(/\/$/, '') }));
        } else if (DISCOVERY_MODE === 'docker') {
          type Container = { Names: string[]; Ports: Array<{ PublicPort?: number }> };
          const containers = await fetchDocker('/containers/json') as Container[];
          candidates = containers
            .map(c => {
              const name = c.Names[0]?.replace(/^\//, '') ?? '';
              const containerPort = c.Ports[0]?.PublicPort ?? port;
              return { name, baseUrl: `http://localhost:${containerPort}` };
            })
            .filter(c => c.name);
        } else {
          // kubernetes (default)
          const data = await fetchK8s(`/api/v1/namespaces/${namespace}/services`);
          candidates = data.items
            .map(svc => (svc['metadata'] as Record<string, unknown>)?.['name'] as string)
            .filter(n => n && n !== 'kubernetes')
            .map(name => ({ name, baseUrl: `http://${name}.${namespace}.svc.cluster.local:${port}` }));
        }

        const results: DiscoveryResult[] = [];
        for (let i = 0; i < candidates.length; i += DISCOVER_CONCURRENCY) {
          const batch = candidates.slice(i, i + DISCOVER_CONCURRENCY);
          const settled = await Promise.allSettled(batch.map(c => probe(c.name, c.baseUrl)));
          for (let j = 0; j < settled.length; j++) {
            const s = settled[j];
            results.push(s.status === 'fulfilled' ? s.value : { serviceName: batch[j].name, status: 'error', error: String(s.reason) });
          }
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              mode: DISCOVERY_MODE, namespace: DISCOVERY_MODE === 'kubernetes' ? namespace : undefined,
              scanned: results.length, discovered: results.filter(r => r.status === 'discovered').length,
              skipped: results.filter(r => r.status === 'no_spec').length,
              errors: results.filter(r => r.status === 'error').length,
              services: results,
            }, null, 2),
          }],
        };
      } catch (err) {
        outcome = 'error';
        throw err;
      } finally {
        end();
        toolCalls.inc({ server: SERVER_NAME, tool: 'auto_discover_contracts', outcome });
      }
    },
  );

  // ── can_i_deploy ──────────────────────────────────────────────────────────

  server.tool(
    'can_i_deploy',
    'Check whether deploying a specific provider version is safe: verifies it still satisfies every ' +
    'currently registered consumer\'s paths, and reports any breaking changes versus the provider\'s ' +
    'current latest version. Use this as a deploy-time gate, analogous to Pactflow\'s can-i-deploy.',
    {
      service_name: z.string().describe('Provider service name'),
      version: z.string().describe('The version about to be deployed'),
    },
    async ({ service_name, version }) => {
      const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'can_i_deploy' });
      agentToolCalls.inc({ server: SERVER_NAME, tool: 'can_i_deploy', agent: agentId });
      let outcome = 'success';
      auditLog({ action: 'can_i_deploy', agent: agentId, service: service_name, version });
      try {
        const target = await store.getByVersion(service_name, version);
        if (!target) {
          return { content: [{ type: 'text' as const, text: `Version ${version} of "${service_name}" is not registered. Register it with register_contract before checking can_i_deploy.` }] };
        }
        const summary = (await store.listAll()).find(s => s.serviceName === service_name);
        const idx = summary?.versions.indexOf(version) ?? -1;
        const previousVersion = idx > 0 ? summary!.versions[idx - 1] : undefined;
        const previousEntry = previousVersion ? await store.getByVersion(service_name, previousVersion) : undefined;
        const targetPaths = new Set(target.paths);
        const all = (await store.listAll()).filter(s => s.serviceName !== service_name);
        const blockingConsumers = (await Promise.all(all.map(async s => {
          const consumerEntry = await store.getLatest(s.serviceName);
          if (!consumerEntry) return null;
          const missing = consumerEntry.paths.filter(p => !targetPaths.has(p));
          return missing.length > 0 ? { consumer: s.serviceName, consumerVersion: consumerEntry.version, missingPaths: missing } : null;
        }))).filter((r): r is { consumer: string; consumerVersion: string; missingPaths: string[] } => r !== null);

        const breakingChanges = previousEntry
          ? detectBreakingChanges(parseSpec(previousEntry.specJson), parseSpec(target.specJson)).breaking
          : [];

        const safe = blockingConsumers.length === 0 && breakingChanges.length === 0;
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              safe,
              service: service_name,
              version,
              previousVersion: previousVersion ?? null,
              blockingConsumers,
              breakingChanges,
              verdict: safe
                ? `✓ SAFE TO DEPLOY — ${service_name}@${version} satisfies all registered consumers with no breaking changes`
                : `✗ NOT SAFE TO DEPLOY — ${blockingConsumers.length} consumer(s) blocked, ${breakingChanges.length} breaking change(s) vs current version`,
            }, null, 2),
          }],
        };
      } catch (err) {
        outcome = 'error';
        throw err;
      } finally {
        end();
        toolCalls.inc({ server: SERVER_NAME, tool: 'can_i_deploy', outcome });
      }
    },
  );

  // ── get_stale_contracts ──────────────────────────────────────────────────

  server.tool(
    'get_stale_contracts',
    'List registered services whose contract has not been updated in a while. Helps keep pacts up to date.',
    { days: z.number().optional().describe('Staleness threshold in days (default: STALE_THRESHOLD_DAYS env var or 30)') },
    async ({ days }) => {
      const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'get_stale_contracts' });
      agentToolCalls.inc({ server: SERVER_NAME, tool: 'get_stale_contracts', agent: agentId });
      let outcome = 'success';
      const threshold = days ?? parseInt(process.env.STALE_THRESHOLD_DAYS ?? '30', 10);
      auditLog({ action: 'get_stale_contracts', agent: agentId, days: threshold });
      try {
        const all = await store.listAll();
        const now = Date.now();
        const stale = all
          .map(s => ({ ...s, ageDays: s.registeredAt ? Math.floor((now - new Date(s.registeredAt).getTime()) / 86400000) : null }))
          .filter(s => s.ageDays !== null && s.ageDays >= threshold);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              thresholdDays: threshold,
              staleCount: stale.length,
              services: stale,
            }, null, 2),
          }],
        };
      } catch (err) {
        outcome = 'error';
        throw err;
      } finally {
        end();
        toolCalls.inc({ server: SERVER_NAME, tool: 'get_stale_contracts', outcome });
      }
    },
  );

  // ── get_audit_log ─────────────────────────────────────────────────────────

  server.tool(
    'get_audit_log',
    'Query recent contract-mcp-server tool usage / audit events. Useful for measuring adoption and usage patterns.',
    {
      service: z.string().optional().describe('Filter by service name'),
      action: z.string().optional().describe('Filter by action/tool name'),
      agent: z.string().optional().describe('Filter by calling agent id'),
      limit: z.number().optional().describe('Max events to return (default 100)'),
    },
    async ({ service, action, agent, limit }) => {
      const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'get_audit_log' });
      agentToolCalls.inc({ server: SERVER_NAME, tool: 'get_audit_log', agent: agentId });
      let outcome = 'success';
      try {
        const events = getAuditLog({ service, action, agent, limit });
        return { content: [{ type: 'text' as const, text: JSON.stringify({ count: events.length, events }, null, 2) }] };
      } catch (err) {
        outcome = 'error';
        throw err;
      } finally {
        end();
        toolCalls.inc({ server: SERVER_NAME, tool: 'get_audit_log', outcome });
      }
    },
  );

  // ── generate_migration_guide ─────────────────────────────────────────────

  server.tool(
    'generate_migration_guide',
    'Generate a markdown migration guide describing breaking changes between two versions of a service ' +
    'and which currently-registered consumers are affected.',
    {
      service_name: z.string().describe('Provider service name'),
      from_version: z.string().describe('The older/baseline version'),
      to_version: z.string().describe('The newer version'),
    },
    async ({ service_name, from_version, to_version }) => {
      const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'generate_migration_guide' });
      agentToolCalls.inc({ server: SERVER_NAME, tool: 'generate_migration_guide', agent: agentId });
      let outcome = 'success';
      auditLog({ action: 'generate_migration_guide', agent: agentId, service: service_name, from_version, to_version });
      try {
        const fromEntry = await store.getByVersion(service_name, from_version);
        const toEntry = await store.getByVersion(service_name, to_version);
        if (!fromEntry) return { content: [{ type: 'text' as const, text: `Version ${from_version} of "${service_name}" not found.` }] };
        if (!toEntry) return { content: [{ type: 'text' as const, text: `Version ${to_version} of "${service_name}" not found.` }] };
        const { breaking } = detectBreakingChanges(parseSpec(fromEntry.specJson), parseSpec(toEntry.specJson));
        const affectedConsumers = await findAffectedConsumers(store, service_name, toEntry.paths);
        const guide = generateMigrationGuide(service_name, from_version, to_version, breaking, affectedConsumers);
        return { content: [{ type: 'text' as const, text: guide }] };
      } catch (err) {
        outcome = 'error';
        throw err;
      } finally {
        end();
        toolCalls.inc({ server: SERVER_NAME, tool: 'generate_migration_guide', outcome });
      }
    },
  );

  return server;
}

// ── Express HTTP server ────────────────────────────────────────────────────

const app = createApp(store);

// Static UI (browser frontend for the REST shim)
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
app.use(express.static(PUBLIC_DIR));

app.get('/healthz', (_req, res) => res.json({ status: 'ok', version: '2.0.0', storageType: process.env.STORAGE_TYPE ?? 'memory', discoveryMode: DISCOVERY_MODE }));
app.get('/ready',   (_req, res) => res.json({ status: 'ready' }));
app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.post('/mcp', express.json(), async (req, res) => {
  const agentId = (req.get('x-agent-id') ?? req.get('user-agent') ?? 'unknown').slice(0, 64);
  const srv = createServer(agentId);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await srv.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(PORT, () => {
  console.log(`Contract MCP Server v2.0.0 listening on :${PORT}`);
  console.log(`  MCP endpoint:  POST http://localhost:${PORT}/mcp`);
  console.log(`  REST API:      http://localhost:${PORT}/api/contracts`);
  console.log(`  Health:        http://localhost:${PORT}/healthz`);
  console.log(`  Storage:       ${process.env.STORAGE_TYPE ?? 'memory'}`);
  console.log(`  Discovery:     ${DISCOVERY_MODE}`);
});
