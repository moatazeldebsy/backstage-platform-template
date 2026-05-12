import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import fetch from 'node-fetch';
import { register, collectDefaultMetrics, Counter, Histogram } from 'prom-client';

const BACKSTAGE_URL = process.env.BACKSTAGE_URL ?? 'http://backstage:7007';
const BACKSTAGE_EXTERNAL_URL = process.env.BACKSTAGE_EXTERNAL_URL ?? 'http://backstage.idp.local';
const BACKSTAGE_TOKEN = process.env.BACKSTAGE_TOKEN ?? '';
const PROMETHEUS_URL = process.env.PROMETHEUS_URL ?? 'http://prometheus-kube-prometheus-prometheus.monitoring:9090';
const PORT = parseInt(process.env.PORT ?? '3002', 10);

collectDefaultMetrics();
const toolCalls = new Counter({ name: 'qa_mcp_tool_calls_total', help: 'Total QA MCP tool calls', labelNames: ['tool'] });
const toolDuration = new Histogram({ name: 'qa_mcp_tool_duration_seconds', help: 'QA MCP tool call duration', labelNames: ['tool'] });

const app = express();

// ── Known test-suite template names ──────────────────────────────────────────
const TEST_SUITE_TEMPLATES = new Set([
  'playwright-e2e-suite',
  'k6-performance-suite',
  'pact-contract-suite',
  'accessibility-suite',
  'appium-mobile-suite',
  'chaos-mesh-suite',
  'datadog-synthetic-suite',
  'visual-regression-suite',
  'zap-dast-suite',
  'mutation-testing-suite',
  'testcontainers-suite',
  'bdd-cucumber-suite',
  'newman-api-suite',
]);

// ── Backstage catalog helper ──────────────────────────────────────────────────

async function fetchCatalog(path: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (BACKSTAGE_TOKEN) headers['Authorization'] = `Bearer ${BACKSTAGE_TOKEN}`;
  const res = await fetch(`${BACKSTAGE_URL}${path}`, { headers });
  if (!res.ok) throw new Error(`Backstage API error ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── Prometheus helper ─────────────────────────────────────────────────────────

async function fetchPrometheus(query: string) {
  const url = `${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Prometheus error ${res.status}`);
  return res.json() as Promise<{ data: { result: Array<{ metric: Record<string, string>; value: [number, string] }> } }>;
}

// ── MCP Server factory ────────────────────────────────────────────────────────
// Stateless Streamable HTTP requires a fresh McpServer per request because
// McpServer.connect() can only be called once per instance.
function createServer() {
  const server = new McpServer({
    name: 'qa-mcp-server',
    version: '1.0.0',
  });

  // ── Tool: list_test_suites ────────────────────────────────────────────────
  server.tool(
    'list_test_suites',
    'List all available QA test suite scaffolder templates with name, title, description, and template ref. ' +
    'Use this to discover what test suites can be scaffolded before calling scaffold_test_suite.',
    {},
    async () => {
      const end = toolDuration.startTimer({ tool: 'list_test_suites' });
      toolCalls.inc({ tool: 'list_test_suites' });
      try {
        const data = await fetchCatalog('/api/catalog/entities?filter=kind=Template&limit=100') as Array<{
          metadata: { name: string; description?: string; title?: string; tags?: string[] };
          spec?: { type?: string };
        }>;
        const suites = data
          .filter(e => e.spec?.type === 'test-suite' || TEST_SUITE_TEMPLATES.has(e.metadata.name))
          .map(e => ({
            name: e.metadata.name,
            title: e.metadata.title ?? e.metadata.name,
            description: e.metadata.description,
            templateRef: `template:default/${e.metadata.name}`,
            tags: e.metadata.tags ?? [],
          }));
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(suites, null, 2) }],
        };
      } finally {
        end();
      }
    }
  );

  // ── Tool: scaffold_test_suite ─────────────────────────────────────────────
  server.tool(
    'scaffold_test_suite',
    'Scaffold a QA test suite from a Backstage template. Only test-suite templates are accepted. ' +
    'IMPORTANT: values must include "repoUrl" in Backstage RepoUrlPicker format: ' +
    '"github.com?owner=OWNER&repo=REPO_NAME" (e.g. "github.com?owner=moatazeldebsy&repo=my-pact-tests"). ' +
    'Required values: name, description, owner (Backstage group ref, e.g. "group:default/qa-team"), ' +
    'repoUrl (RepoUrlPicker format). ' +
    'Call list_test_suites first to pick the right templateRef.',
    {
      template_ref: z.string().describe(
        'Test suite template entity ref, e.g. template:default/playwright-e2e-suite or template:default/pact-contract-suite'
      ),
      values: z.record(z.string(), z.unknown()).describe(
        'Template parameter values. Required: name, description, owner, repoUrl. ' +
        'repoUrl format: "github.com?owner=OWNER&repo=REPO_NAME". Auto-constructed from name+owner if omitted.'
      ),
    },
    async ({ template_ref, values }) => {
      const end = toolDuration.startTimer({ tool: 'scaffold_test_suite' });
      toolCalls.inc({ tool: 'scaffold_test_suite' });
      try {
        // Validate the templateRef resolves to a known test-suite template
        const refParts = template_ref.split('/');
        const templateName = refParts[refParts.length - 1];
        if (!TEST_SUITE_TEMPLATES.has(templateName)) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                error: `"${templateName}" is not a test-suite template. ` +
                  `Valid templates: ${[...TEST_SUITE_TEMPLATES].join(', ')}. ` +
                  `Call list_test_suites to see all options with descriptions.`,
              }),
            }],
          };
        }

        // Normalise repoUrl to Backstage RepoUrlPicker format
        const enrichedValues: Record<string, unknown> = { ...values };
        const repoName = (enrichedValues['name'] as string | undefined) ?? '';
        const rawOwner = (enrichedValues['owner'] as string | undefined) ?? '';
        const ghOwner = rawOwner.includes('/') ? rawOwner.split('/').pop()! : (rawOwner || 'moatazeldebsy');

        if (!enrichedValues['repoUrl']) {
          enrichedValues['repoUrl'] = `github.com?owner=${encodeURIComponent(ghOwner)}&repo=${encodeURIComponent(repoName)}`;
        } else if (
          typeof enrichedValues['repoUrl'] === 'string' &&
          enrichedValues['repoUrl'].startsWith('https://github.com/')
        ) {
          const parts = enrichedValues['repoUrl'].replace('https://github.com/', '').split('/');
          const urlOwner = parts[0] ?? ghOwner;
          const urlRepo = parts[1] ?? repoName;
          enrichedValues['repoUrl'] = `github.com?owner=${encodeURIComponent(urlOwner)}&repo=${encodeURIComponent(urlRepo)}`;
        }

        const authHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
        if (BACKSTAGE_TOKEN) authHeaders['Authorization'] = `Bearer ${BACKSTAGE_TOKEN}`;
        const res = await fetch(`${BACKSTAGE_URL}/api/scaffolder/v2/tasks`, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({ templateRef: template_ref, values: enrichedValues }),
        });
        if (!res.ok) throw new Error(`Scaffolder error ${res.status}: ${await res.text()}`);
        const task = await res.json() as { id: string };

        // Poll for task completion so callers don't need authenticated status requests.
        const pollHeaders: Record<string, string> = {};
        if (BACKSTAGE_TOKEN) pollHeaders['Authorization'] = `Bearer ${BACKSTAGE_TOKEN}`;
        const POLL_INTERVAL_MS = 4000;
        const POLL_TIMEOUT_MS = 180000; // 3 minutes
        const deadline = Date.now() + POLL_TIMEOUT_MS;
        let taskStatus = 'processing';
        let taskOutput: unknown = undefined;
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
          const statusRes = await fetch(`${BACKSTAGE_URL}/api/scaffolder/v2/tasks/${task.id}`, { headers: pollHeaders });
          if (statusRes.ok) {
            const statusBody = await statusRes.json() as { status: string; output?: unknown };
            taskStatus = statusBody.status;
            taskOutput = statusBody.output;
            if (taskStatus === 'completed' || taskStatus === 'failed' || taskStatus === 'cancelled') break;
          }
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              task_id: task.id,
              status: taskStatus,
              output: taskOutput,
              ui_url: `${BACKSTAGE_EXTERNAL_URL}/create/tasks/${task.id}`,
            }, null, 2),
          }],
        };
      } finally {
        end();
      }
    }
  );

  // ── Tool: search_test_catalog ─────────────────────────────────────────────
  server.tool(
    'search_test_catalog',
    'Search the Backstage catalog for QA test suites and testing-related components. ' +
    'Returns entities tagged "qa"/"testing", type "test-suite", or matching the query.',
    {
      query: z.string().describe(
        'Search term — suite name, service name, or testing keyword (e.g. "contract", "e2e", "performance", "pact")'
      ),
      service: z.string().optional().describe(
        'Narrow results to suites related to a specific service name (e.g. "hello-service")'
      ),
    },
    async ({ query, service }) => {
      const end = toolDuration.startTimer({ tool: 'search_test_catalog' });
      toolCalls.inc({ tool: 'search_test_catalog' });
      try {
        const all = await fetchCatalog('/api/catalog/entities?limit=200') as Array<{
          metadata: { name: string; description?: string; tags?: string[] };
          kind: string;
          spec?: { type?: string; owner?: string };
        }>;
        const ql = query.toLowerCase();
        const sl = service?.toLowerCase();
        const matches = all.filter(e => {
          const tags = e.metadata.tags ?? [];
          const isQaTagged = tags.some(t => t === 'qa' || t === 'testing' || t === 'test-suite');
          const isTestSuiteType = e.spec?.type === 'test-suite';
          const nameMatch = e.metadata.name.toLowerCase().includes(ql);
          const descMatch = (e.metadata.description ?? '').toLowerCase().includes(ql);
          const serviceMatch = sl
            ? e.metadata.name.toLowerCase().includes(sl) ||
              (e.metadata.description ?? '').toLowerCase().includes(sl)
            : true;
          return (isQaTagged || isTestSuiteType || nameMatch || descMatch) && serviceMatch;
        });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(matches.slice(0, 20).map(e => ({
              name: e.metadata.name,
              kind: e.kind,
              type: e.spec?.type,
              owner: e.spec?.owner,
              description: e.metadata.description,
              tags: e.metadata.tags,
            })), null, 2),
          }],
        };
      } finally {
        end();
      }
    }
  );

  // ── Tool: get_test_metrics ────────────────────────────────────────────────
  server.tool(
    'get_test_metrics',
    'Query Prometheus for test-related metrics for a service. ' +
    'Returns test pass rate, execution count, and duration where available.',
    {
      service_name: z.string().describe('The service name to query test metrics for (e.g. hello-service)'),
      metric: z.string().optional().describe(
        'Specific metric name. If omitted, common test metric patterns are tried. ' +
        'Examples: test_runs_total, test_duration_seconds, test_pass_rate'
      ),
    },
    async ({ service_name, metric }) => {
      const end = toolDuration.startTimer({ tool: 'get_test_metrics' });
      toolCalls.inc({ tool: 'get_test_metrics' });
      try {
        const queries = metric
          ? [`${metric}{job="${service_name}"}`]
          : [
              `test_runs_total{job="${service_name}"}`,
              `test_duration_seconds{job="${service_name}"}`,
              `{__name__=~"test.*",job="${service_name}"}`,
              `{__name__=~".*test.*",job="${service_name}"}`,
            ];

        const results: Array<{ query: string; data: unknown[] }> = [];
        for (const q of queries) {
          try {
            const data = await fetchPrometheus(q);
            if (data.data.result.length > 0) {
              results.push({
                query: q,
                data: data.data.result.map(r => ({
                  labels: r.metric,
                  value: r.value[1],
                  timestamp: new Date(r.value[0] * 1000).toISOString(),
                })),
              });
            }
          } catch {
            // skip individual query failures — another query may succeed
          }
        }

        return {
          content: [{
            type: 'text' as const,
            text: results.length > 0
              ? JSON.stringify(results, null, 2)
              : `No test metrics found for service "${service_name}". ` +
                `The service may not expose test metrics yet. ` +
                `Consider instrumenting tests with prom-client or a test results exporter.`,
          }],
        };
      } finally {
        end();
      }
    }
  );

  return server;
}

// ── Express HTTP server with Streamable HTTP transport ──────────────────────

app.get('/healthz', (_req, res) => res.json({ status: 'ok', version: '1.0.0' }));
app.get('/ready', (_req, res) => res.json({ status: 'ready' }));
app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// Stateless Streamable HTTP — each request gets a fresh McpServer+transport.
// This is required because McpServer.connect() can only be called once per instance.
app.post('/mcp', express.json(), async (req, res) => {
  const srv = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await srv.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(PORT, () => {
  console.log(`QA MCP Server listening on :${PORT}`);
  console.log(`  MCP endpoint: http://localhost:${PORT}/mcp`);
  console.log(`  Health:       http://localhost:${PORT}/healthz`);
});
