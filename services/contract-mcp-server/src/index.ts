import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import fs from 'fs';
import { register, collectDefaultMetrics, Counter, Histogram } from 'prom-client';
import { register as registerContract, getLatest, getByVersion, listAll } from './store.js';
import { parseSpec, generatePactJson, generatePactTestCode, detectBreakingChanges } from './generator.js';

const PORT = parseInt(process.env.PORT ?? '3003', 10);
const K8S_API = process.env.K8S_API ?? 'https://kubernetes.default.svc';
const K8S_TOKEN = process.env.K8S_TOKEN ?? '';
const HTTP_TIMEOUT_MS = parseInt(process.env.HTTP_TIMEOUT_MS ?? '8000', 10);
const DISCOVER_PROBE_TIMEOUT_MS = parseInt(process.env.DISCOVER_PROBE_TIMEOUT_MS ?? '2500', 10);
const DISCOVER_CONCURRENCY = parseInt(process.env.DISCOVER_CONCURRENCY ?? '10', 10);

// Service-account token is read once at boot; kubelet rotates the file
// in-place, so re-reading per request just adds blocking I/O on the hot path.
const SA_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';
let cachedSaToken = '';
try {
  if (fs.existsSync(SA_TOKEN_PATH)) {
    cachedSaToken = fs.readFileSync(SA_TOKEN_PATH, 'utf8').trim();
    fs.watch(SA_TOKEN_PATH, { persistent: false }, () => {
      try {
        cachedSaToken = fs.readFileSync(SA_TOKEN_PATH, 'utf8').trim();
      } catch { /* ignore — keep last good token until next rotation */ }
    });
  }
} catch { /* not running in-cluster; K8S_TOKEN env var is used instead */ }

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

collectDefaultMetrics();
const toolCalls = new Counter({ name: 'mcp_tool_calls_total', help: 'Total MCP tool calls', labelNames: ['tool'] });
const toolDuration = new Histogram({ name: 'mcp_tool_duration_seconds', help: 'MCP tool call duration', labelNames: ['tool'] });

const app = express();

// Stateless factory — fresh McpServer per request (McpServer.connect() is one-shot)
function createServer() {
  const server = new McpServer({ name: 'contract-mcp-server', version: '1.0.0' });

  server.tool(
    'register_contract',
    'Register or update an OpenAPI spec for a service. The spec can be JSON or YAML string. ' +
    'Call this whenever a service\'s API spec changes to keep the contract registry current.',
    {
      service_name: z.string().describe('Service name (e.g. hello-service, payment-api)'),
      version: z.string().describe('Semver version string, e.g. 1.0.0 or 2.1.0'),
      openapi_spec: z.string().describe('Full OpenAPI 3.x spec as a JSON or YAML string'),
    },
    async ({ service_name, version, openapi_spec }) => {
      const end = toolDuration.startTimer({ tool: 'register_contract' });
      toolCalls.inc({ tool: 'register_contract' });
      try {
        const entry = registerContract(service_name, version, openapi_spec);
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
            }, null, 2),
          }],
        };
      } finally {
        end();
      }
    }
  );

  server.tool(
    'get_contract',
    'Retrieve a registered OpenAPI contract for a service. Returns the latest version by default.',
    {
      service_name: z.string().describe('Service name to look up'),
      version: z.string().optional().describe('Specific version to retrieve (default: latest)'),
    },
    async ({ service_name, version }) => {
      const end = toolDuration.startTimer({ tool: 'get_contract' });
      toolCalls.inc({ tool: 'get_contract' });
      try {
        const entry = version ? getByVersion(service_name, version) : getLatest(service_name);
        if (!entry) {
          return {
            content: [{
              type: 'text' as const,
              text: `No contract found for service "${service_name}"${version ? ` version ${version}` : ''}. Register one first with register_contract.`,
            }],
          };
        }
        const spec = JSON.parse(entry.specJson) as object;
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              serviceName: service_name,
              version: entry.version,
              timestamp: entry.timestamp,
              paths: entry.paths,
              spec,
            }, null, 2),
          }],
        };
      } finally {
        end();
      }
    }
  );

  server.tool(
    'list_contracts',
    'List all services that have registered contracts, with their available versions.',
    {},
    async () => {
      const end = toolDuration.startTimer({ tool: 'list_contracts' });
      toolCalls.inc({ tool: 'list_contracts' });
      try {
        const all = listAll();
        return {
          content: [{
            type: 'text' as const,
            text: all.length === 0
              ? 'No contracts registered yet. Use register_contract to add a service spec.'
              : JSON.stringify(all, null, 2),
          }],
        };
      } finally {
        end();
      }
    }
  );

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
      const end = toolDuration.startTimer({ tool: 'generate_contract_tests' });
      toolCalls.inc({ tool: 'generate_contract_tests' });
      try {
        const entry = version ? getByVersion(service_name, version) : getLatest(service_name);
        if (!entry) {
          return {
            content: [{
              type: 'text' as const,
              text: `No contract found for provider "${service_name}". Register it first with register_contract.`,
            }],
          };
        }
        const spec = parseSpec(entry.specJson);
        const pactJson = generatePactJson(consumer_name, service_name, spec);
        const testCode = generatePactTestCode(consumer_name, service_name, spec);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              provider: service_name,
              consumer: consumer_name,
              specVersion: entry.version,
              pactJson,
              testCode,
              instructions: [
                `Save pactJson to ./pacts/${consumer_name}-${service_name}.json`,
                `Save testCode to ./tests/${consumer_name}-${service_name}.pact.spec.ts`,
                'Run: npm test to verify the consumer tests pass',
                'Optionally publish pactJson to a Pact broker',
              ],
            }, null, 2),
          }],
        };
      } finally {
        end();
      }
    }
  );

  server.tool(
    'validate_compatibility',
    'Check if a provider\'s current spec satisfies all the paths expected by a consumer. ' +
    'Both services must have registered contracts. Returns pass/fail with details.',
    {
      provider_name: z.string().describe('Provider service name'),
      consumer_name: z.string().describe('Consumer service name (must also have a registered spec)'),
    },
    async ({ provider_name, consumer_name }) => {
      const end = toolDuration.startTimer({ tool: 'validate_compatibility' });
      toolCalls.inc({ tool: 'validate_compatibility' });
      try {
        const providerEntry = getLatest(provider_name);
        const consumerEntry = getLatest(consumer_name);
        if (!providerEntry) {
          return { content: [{ type: 'text' as const, text: `Provider "${provider_name}" has no registered contract.` }] };
        }
        if (!consumerEntry) {
          return { content: [{ type: 'text' as const, text: `Consumer "${consumer_name}" has no registered contract. Register its expected API paths.` }] };
        }
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
      } finally {
        end();
      }
    }
  );

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
      const end = toolDuration.startTimer({ tool: 'detect_breaking_changes' });
      toolCalls.inc({ tool: 'detect_breaking_changes' });
      try {
        const fromEntry = getByVersion(service_name, from_version);
        const toEntry = getByVersion(service_name, to_version);
        if (!fromEntry) {
          return { content: [{ type: 'text' as const, text: `Version ${from_version} of "${service_name}" not found.` }] };
        }
        if (!toEntry) {
          return { content: [{ type: 'text' as const, text: `Version ${to_version} of "${service_name}" not found.` }] };
        }
        const fromSpec = parseSpec(fromEntry.specJson);
        const toSpec = parseSpec(toEntry.specJson);
        const result = detectBreakingChanges(fromSpec, toSpec);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              serviceName: service_name,
              fromVersion: from_version,
              toVersion: to_version,
              ...result,
            }, null, 2),
          }],
        };
      } finally {
        end();
      }
    }
  );

  server.tool(
    'get_compatibility_report',
    'Generate a full compatibility report for a provider service: lists all registered services ' +
    'and checks whether each could be a compatible consumer of this provider.',
    {
      service_name: z.string().describe('Provider service name to generate the report for'),
    },
    async ({ service_name }) => {
      const end = toolDuration.startTimer({ tool: 'get_compatibility_report' });
      toolCalls.inc({ tool: 'get_compatibility_report' });
      try {
        const providerEntry = getLatest(service_name);
        if (!providerEntry) {
          return { content: [{ type: 'text' as const, text: `Provider "${service_name}" has no registered contract.` }] };
        }
        const providerPaths = new Set(providerEntry.paths);
        const all = listAll().filter(s => s.serviceName !== service_name);
        const report = all.map(s => {
          const consumerEntry = getLatest(s.serviceName);
          if (!consumerEntry) return { consumer: s.serviceName, compatible: null, detail: 'No contract registered' };
          const missing = consumerEntry.paths.filter(p => !providerPaths.has(p));
          return {
            consumer: s.serviceName,
            consumerVersion: consumerEntry.version,
            compatible: missing.length === 0,
            missingPaths: missing,
            detail: missing.length === 0 ? 'Compatible' : `Missing: ${missing.join(', ')}`,
          };
        });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              provider: service_name,
              providerVersion: providerEntry.version,
              totalConsumers: report.length,
              compatible: report.filter(r => r.compatible === true).length,
              incompatible: report.filter(r => r.compatible === false).length,
              consumers: report,
            }, null, 2),
          }],
        };
      } finally {
        end();
      }
    }
  );

  server.tool(
    'fetch_service_contract',
    'Pull an OpenAPI spec directly from a running service and auto-register it as a contract. ' +
    'The service must expose GET /openapi.json or /openapi.yaml at its HTTP endpoint. ' +
    'This is the self-describing pattern: services document themselves at runtime — no manual spec upload needed.',
    {
      service_name: z.string().describe('Kubernetes service name (e.g. hello-service)'),
      namespace: z.string().optional().describe('Kubernetes namespace where the service runs (default: services)'),
      port: z.number().optional().describe('Service port (default: 80)'),
      openapi_path: z.string().optional().describe('Explicit path to fetch (default: tries /openapi.json then /openapi.yaml)'),
      version: z.string().optional().describe('Version label to register under (default: taken from spec info.version)'),
    },
    async ({ service_name, namespace = 'services', port = 80, openapi_path, version }) => {
      const end = toolDuration.startTimer({ tool: 'fetch_service_contract' });
      toolCalls.inc({ tool: 'fetch_service_contract' });
      try {
        const tryPaths = openapi_path ? [openapi_path] : ['/openapi.json', '/openapi.yaml', '/api-docs', '/swagger.json'];
        const baseUrl = `http://${service_name}.${namespace}.svc.cluster.local:${port}`;

        let specText: string | null = null;
        let fetchedPath = '';

        for (const p of tryPaths) {
          try {
            const res = await fetchWithTimeout(`${baseUrl}${p}`, 3000);
            if (res.ok) {
              specText = await res.text();
              fetchedPath = p;
              break;
            }
          } catch {
            // try next path
          }
        }

        if (!specText) {
          return {
            content: [{
              type: 'text' as const,
              text: `No OpenAPI spec found at ${baseUrl}. Tried: ${tryPaths.join(', ')}. ` +
                    `The service needs to expose one of these endpoints to be self-describing.`,
            }],
          };
        }

        const parsed = parseSpec(specText);
        const specVersion = version ?? parsed.info?.version ?? new Date().toISOString().slice(0, 10);
        const entry = registerContract(service_name, specVersion, specText);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              discovered: true,
              serviceName: service_name,
              source: `${baseUrl}${fetchedPath}`,
              version: specVersion,
              title: parsed.info?.title,
              description: parsed.info?.description,
              pathCount: entry.paths.length,
              paths: entry.paths,
              timestamp: entry.timestamp,
            }, null, 2),
          }],
        };
      } finally {
        end();
      }
    }
  );

  server.tool(
    'auto_discover_contracts',
    'Scan all running services in a Kubernetes namespace, pull their OpenAPI specs, ' +
    'and auto-register each as a contract. One call makes the entire namespace self-describing. ' +
    'Services without an /openapi.json endpoint are skipped (reported as no_spec).',
    {
      namespace: z.string().optional().describe('Kubernetes namespace to scan (default: services)'),
      port: z.number().optional().describe('Port to try on each service (default: 80)'),
    },
    async ({ namespace = 'services', port = 80 }) => {
      const end = toolDuration.startTimer({ tool: 'auto_discover_contracts' });
      toolCalls.inc({ tool: 'auto_discover_contracts' });
      try {
        const data = await fetchK8s(`/api/v1/namespaces/${namespace}/services`);

        type DiscoveryResult = {
          serviceName: string;
          status: 'discovered' | 'no_spec' | 'error';
          version?: string;
          title?: string;
          paths?: string[];
          error?: string;
        };

        // Probe each service in parallel (bounded). Sequential probing of N
        // services × 2.5s per path made discovery O(N) on the wall clock and
        // unusable in namespaces with many services.
        const candidates = data.items
          .map(svc => (svc['metadata'] as Record<string, unknown>)?.['name'] as string)
          .filter(n => n && n !== 'kubernetes');
        const tryPaths = ['/openapi.json', '/openapi.yaml'];

        async function probe(serviceName: string): Promise<DiscoveryResult> {
          const baseUrl = `http://${serviceName}.${namespace}.svc.cluster.local:${port}`;
          for (const p of tryPaths) {
            try {
              const res = await fetchWithTimeout(`${baseUrl}${p}`, DISCOVER_PROBE_TIMEOUT_MS);
              if (res.ok) {
                const specText = await res.text();
                const parsed = parseSpec(specText);
                const specVersion = parsed.info?.version ?? new Date().toISOString().slice(0, 10);
                const entry = registerContract(serviceName, specVersion, specText);
                return {
                  serviceName,
                  status: 'discovered',
                  version: specVersion,
                  title: parsed.info?.title,
                  paths: entry.paths,
                };
              }
            } catch {
              // try next path
            }
          }
          return { serviceName, status: 'no_spec' };
        }

        const results: DiscoveryResult[] = [];
        for (let i = 0; i < candidates.length; i += DISCOVER_CONCURRENCY) {
          const batch = candidates.slice(i, i + DISCOVER_CONCURRENCY);
          const settled = await Promise.allSettled(batch.map(probe));
          for (let j = 0; j < settled.length; j++) {
            const s = settled[j];
            results.push(s.status === 'fulfilled'
              ? s.value
              : { serviceName: batch[j], status: 'error', error: String(s.reason) });
          }
        }

        const discovered = results.filter(r => r.status === 'discovered');
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              namespace,
              scanned: results.length,
              discovered: discovered.length,
              skipped: results.filter(r => r.status === 'no_spec').length,
              services: results,
            }, null, 2),
          }],
        };
      } finally {
        end();
      }
    }
  );

  return server;
}

// ── Express HTTP server ────────────────────────────────────────────────────

app.get('/healthz', (_req, res) => res.json({ status: 'ok', version: '1.0.0' }));
app.get('/ready', (_req, res) => res.json({ status: 'ready' }));
app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.post('/mcp', express.json(), async (req, res) => {
  const srv = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await srv.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(PORT, () => {
  console.log(`Contract MCP Server listening on :${PORT}`);
  console.log(`  MCP endpoint: http://localhost:${PORT}/mcp`);
  console.log(`  Health:       http://localhost:${PORT}/healthz`);
});
