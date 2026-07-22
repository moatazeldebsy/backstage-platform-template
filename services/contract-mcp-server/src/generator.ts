import yaml from 'js-yaml';

export interface OpenAPISpec {
  openapi?: string;
  swagger?: string;
  info?: { title?: string; version?: string; description?: string };
  paths?: Record<string, Record<string, OpenAPIOperation>>;
  components?: Record<string, unknown>;
}

interface OpenAPISchema {
  type?: string;
  format?: string;
  properties?: Record<string, OpenAPISchema>;
  items?: OpenAPISchema;
  required?: string[];
  example?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  pattern?: string;
  $ref?: string;
}

interface OpenAPIOperation {
  summary?: string;
  description?: string;
  operationId?: string;
  parameters?: Array<{ name: string; in: string; required?: boolean; schema?: OpenAPISchema; example?: unknown }>;
  requestBody?: { required?: boolean; content?: Record<string, { schema?: OpenAPISchema }> };
  responses?: Record<string, { description?: string; content?: Record<string, { schema?: OpenAPISchema }> }>;
}

export function parseSpec(specString: string): OpenAPISpec {
  try {
    return JSON.parse(specString) as OpenAPISpec;
  } catch {
    return yaml.load(specString) as OpenAPISpec;
  }
}

export function extractPaths(spec: OpenAPISpec): string[] {
  return Object.keys(spec.paths ?? {});
}

// ── Schema helpers ─────────────────────────────────────────────────────────

function schemaToExample(schema: OpenAPISchema | undefined, depth = 0): unknown {
  if (!schema || depth > 3) return null;
  if (schema.example !== undefined) return schema.example;
  if (schema.enum && schema.enum.length > 0) return schema.enum[0];
  switch (schema.type) {
    case 'string':
      if (schema.format === 'uuid') return '550e8400-e29b-41d4-a716-446655440000';
      if (schema.format === 'email') return 'user@example.com';
      if (schema.format === 'date') return '2024-01-15';
      if (schema.format === 'date-time') return '2024-01-15T10:30:00Z';
      if (schema.format === 'uri') return 'https://example.com';
      return 'string';
    case 'integer': return schema.minimum ?? 1;
    case 'number': return schema.minimum ?? 1.0;
    case 'boolean': return true;
    case 'array': return [schemaToExample(schema.items, depth + 1)];
    case 'object': {
      if (!schema.properties) return {};
      const obj: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(schema.properties)) {
        obj[k] = schemaToExample(v, depth + 1);
      }
      return obj;
    }
    default: return null;
  }
}

// Returns a Pact MatchersV3 expression as a code string for embedding in generated test files.
function schemaToMatcherCode(schema: OpenAPISchema | undefined, depth = 0): string {
  if (!schema || depth > 2) return 'like(null)';
  if (schema.example !== undefined) return `like(${JSON.stringify(schema.example)})`;
  if (schema.enum && schema.enum.length > 0) return `like(${JSON.stringify(schema.enum[0])})`;

  switch (schema.type) {
    case 'string':
      if (schema.format === 'uuid') return `regex('550e8400-e29b-41d4-a716-446655440000', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)`;
      if (schema.format === 'email') return `like('user@example.com')`;
      if (schema.format === 'date-time') return `like('2024-01-15T10:30:00Z')`;
      if (schema.format === 'date') return `like('2024-01-15')`;
      if (schema.pattern) {
        // Escape forward slashes and control characters so the pattern is safe inside a /.../ literal.
        const escaped = schema.pattern.replace(/\\/g, '\\\\').replace(/\//g, '\\/').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
        return `regex('example-value', /${escaped}/)`;
      }
      return `like('string')`;
    case 'integer': return `integer(${schema.minimum ?? 1})`;
    case 'number': return `decimal(${schema.minimum ?? 1.0})`;
    case 'boolean': return `like(true)`;
    case 'array':
      if (!schema.items) return `like([])`;
      return `eachLike(${schemaToMatcherCode(schema.items, depth + 1)})`;
    case 'object': {
      if (!schema.properties || Object.keys(schema.properties).length === 0) return 'like({})';
      const fields = Object.entries(schema.properties)
        .map(([k, v]) => `${k}: ${schemaToMatcherCode(v, depth + 1)}`);
      return `like({ ${fields.join(', ')} })`;
    }
    default:
      return 'like(null)';
  }
}

// ── Schema context extraction (for enriched MCP tool responses) ────────────

export interface OperationContext {
  summary?: string;
  parameters: Array<{ name: string; in: string; required: boolean; type?: string }>;
  requestBody?: {
    required: boolean;
    contentType: string;
    properties: string[];
    required_fields: string[];
    example: unknown;
  };
  responses: Record<string, { contentType?: string; properties?: string[]; example?: unknown }>;
}

export function extractSchemaContext(spec: OpenAPISpec): Record<string, Record<string, OperationContext>> {
  const context: Record<string, Record<string, OperationContext>> = {};
  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    context[path] = {};
    for (const [method, operation] of Object.entries(methods)) {
      if (!['get', 'post', 'put', 'delete', 'patch', 'head'].includes(method)) continue;
      const op = operation as OpenAPIOperation;
      const requestBodySchema = op.requestBody?.content?.['application/json']?.schema;
      const responseEntries = Object.entries(op.responses ?? {}).map(([code, resp]) => {
        const schema = resp.content?.['application/json']?.schema;
        return [code, {
          ...(schema ? {
            contentType: 'application/json',
            properties: Object.keys(schema.properties ?? {}),
            example: schemaToExample(schema, 0),
          } : {}),
        }] as [string, OperationContext['responses'][string]];
      });
      context[path][method] = {
        summary: op.summary,
        parameters: (op.parameters ?? []).map(p => ({
          name: p.name,
          in: p.in,
          required: p.required ?? false,
          type: p.schema?.type,
        })),
        ...(requestBodySchema ? {
          requestBody: {
            required: op.requestBody?.required ?? false,
            contentType: 'application/json',
            properties: Object.keys(requestBodySchema.properties ?? {}),
            required_fields: requestBodySchema.required ?? [],
            example: schemaToExample(requestBodySchema, 0),
          },
        } : {}),
        responses: Object.fromEntries(responseEntries),
      };
    }
  }
  return context;
}

// ── Pact JSON generation ───────────────────────────────────────────────────

export interface PactInteraction {
  description: string;
  providerStates?: Array<{ name: string }>;
  request: { method: string; path: string; headers?: Record<string, string>; query?: Record<string, unknown>; body?: unknown };
  response: { status: number; headers?: Record<string, string>; body?: unknown };
}

export function generatePactJson(consumerName: string, providerName: string, spec: OpenAPISpec): object {
  const interactions: PactInteraction[] = [];

  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(methods)) {
      if (!['get', 'post', 'put', 'delete', 'patch', 'head'].includes(method)) continue;
      const op = operation as OpenAPIOperation;
      const successCode = Object.keys(op.responses ?? {}).find(c => c.startsWith('2')) ?? '200';
      const requestBodySchema = op.requestBody?.content?.['application/json']?.schema;
      const successResp = Object.entries(op.responses ?? {}).find(([c]) => c.startsWith('2'));
      const responseBodySchema = successResp?.[1]?.content?.['application/json']?.schema;

      const queryParams = (op.parameters ?? []).filter(p => p.in === 'query' && p.required);
      const queryObj = queryParams.length > 0
        ? Object.fromEntries(queryParams.map(p => [p.name, p.example ?? schemaToExample(p.schema, 0) ?? 'value']))
        : undefined;

      interactions.push({
        description: op.summary ?? `${method.toUpperCase()} ${path}`,
        providerStates: [{ name: `${providerName} is available` }],
        request: {
          method: method.toUpperCase(),
          path,
          ...(queryObj ? { query: queryObj } : {}),
          ...(requestBodySchema ? {
            headers: { 'Content-Type': 'application/json' },
            body: schemaToExample(requestBodySchema, 0),
          } : {}),
        },
        response: {
          status: parseInt(successCode, 10),
          ...(responseBodySchema ? {
            headers: { 'Content-Type': 'application/json' },
            body: schemaToExample(responseBodySchema, 0),
          } : {}),
        },
      });
    }
  }

  return {
    consumer: { name: consumerName },
    provider: { name: providerName },
    interactions,
    metadata: {
      pactSpecification: { version: '3.0.0' },
      client: { name: 'contract-mcp-server', version: '1.0.0' },
      createdAt: new Date().toISOString(),
    },
  };
}

// ── Pact TypeScript test code generation ──────────────────────────────────

export function generatePactTestCode(consumerName: string, providerName: string, spec: OpenAPISpec): string {
  const interactions: string[] = [];

  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(methods)) {
      if (!['get', 'post', 'put', 'delete', 'patch', 'head'].includes(method)) continue;
      const op = operation as OpenAPIOperation;
      const desc = op.summary ?? `${method.toUpperCase()} ${path}`;
      const successCode = Object.keys(op.responses ?? {}).find(c => c.startsWith('2')) ?? '200';

      const requestBodySchema = op.requestBody?.content?.['application/json']?.schema;
      const successResp = Object.entries(op.responses ?? {}).find(([c]) => c.startsWith('2'));
      const responseBodySchema = successResp?.[1]?.content?.['application/json']?.schema;

      const queryParams = (op.parameters ?? []).filter(p => p.in === 'query' && p.required);
      const queryBlock = queryParams.length > 0
        ? `        query: { ${queryParams.map(p => `${p.name}: like(${JSON.stringify(p.example ?? schemaToExample(p.schema, 0) ?? 'value')})`).join(', ')} },\n`
        : '';
      const requestBodyBlock = requestBodySchema
        ? `        headers: { 'Content-Type': 'application/json' },\n        body: ${schemaToMatcherCode(requestBodySchema)},\n`
        : '';
      const responseBodyBlock = responseBodySchema
        ? `        headers: { 'Content-Type': 'application/json' },\n        body: ${schemaToMatcherCode(responseBodySchema)},\n`
        : '';

      const bodyExample = requestBodySchema ? JSON.stringify(schemaToExample(requestBodySchema, 0), null, 2).replace(/\n/g, '\n          ') : null;
      const fetchCall = bodyExample
        ? `const response = await fetch(\`\${mockServer.url}${path}\`, {\n          method: '${method.toUpperCase()}',\n          headers: { 'Content-Type': 'application/json' },\n          body: JSON.stringify(${bodyExample}),\n        });`
        : `const response = await fetch(\`\${mockServer.url}${path}\`);`;

      const responseAssertions: string[] = [`        expect(response.status).toBe(${successCode});`];
      if (responseBodySchema?.properties) {
        const topKeys = Object.keys(responseBodySchema.properties).slice(0, 3);
        if (topKeys.length > 0) {
          // Parse body AFTER the status assertion so a failing status is reported cleanly.
          responseAssertions.push(`        const body = await response.json() as Record<string, unknown>;`);
          for (const k of topKeys) {
            responseAssertions.push(`        expect(body.${k}).toBeDefined();`);
          }
        }
      }

      interactions.push(`
  it('${desc.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}', async () => {
    await provider
      .given('${providerName} is available')
      .uponReceiving('a request to ${method.toUpperCase()} ${path}')
      .withRequest({
        method: '${method.toUpperCase()}',
        path: '${path}',
${queryBlock}${requestBodyBlock}      })
      .willRespondWith({
        status: ${successCode},
${responseBodyBlock}      })
      .executeTest(async (mockServer) => {
        ${fetchCall}
${responseAssertions.join('\n')}
      });
  });`);
    }
  }

  return `import { PactV3, MatchersV3 } from '@pact-foundation/pact';
import * as path from 'path';

const { like, eachLike, regex, integer, decimal } = MatchersV3;

const provider = new PactV3({
  consumer: '${consumerName}',
  provider: '${providerName}',
  dir: path.resolve(process.cwd(), 'pacts'),
});

describe('${consumerName} → ${providerName} contract', () => {${interactions.join('')}
});
`;
}

export interface BreakingChange {
  type: 'path_removed' | 'method_removed' | 'required_param_added' | 'response_property_removed';
  path: string;
  method?: string;
  detail: string;
}

export function detectBreakingChanges(
  fromSpec: OpenAPISpec,
  toSpec: OpenAPISpec
): { breaking: BreakingChange[]; nonBreaking: string[]; summary: string } {
  const breaking: BreakingChange[] = [];
  const nonBreaking: string[] = [];
  const toPaths = toSpec.paths ?? {};

  for (const [path, methods] of Object.entries(fromSpec.paths ?? {})) {
    if (!toPaths[path]) {
      breaking.push({ type: 'path_removed', path, detail: `Path ${path} was removed` });
      continue;
    }
    for (const [method, operation] of Object.entries(methods)) {
      if (!['get', 'post', 'put', 'delete', 'patch', 'head'].includes(method)) continue;
      if (!toPaths[path][method]) {
        breaking.push({ type: 'method_removed', path, method: method.toUpperCase(), detail: `${method.toUpperCase()} ${path} was removed` });
        continue;
      }
      const fromOp = operation as OpenAPIOperation;
      const toOp = toPaths[path][method] as OpenAPIOperation;
      const fromRequired = (fromOp.parameters ?? []).filter(p => p.required).map(p => p.name);
      const toRequired = (toOp.parameters ?? []).filter(p => p.required).map(p => p.name);
      for (const param of toRequired) {
        if (!fromRequired.includes(param)) {
          breaking.push({ type: 'required_param_added', path, method: method.toUpperCase(), detail: `Required parameter '${param}' added to ${method.toUpperCase()} ${path}` });
        }
      }

      // Check response schema — removed properties are breaking for consumers
      for (const statusCode of ['200', '201']) {
        const fromSchema = fromOp.responses?.[statusCode]?.content?.['application/json']?.schema;
        const toSchema = toOp.responses?.[statusCode]?.content?.['application/json']?.schema;
        if (!fromSchema) continue;
        // Unwrap array items
        const fromProps = fromSchema.type === 'array' ? fromSchema.items?.properties : fromSchema.properties;
        const toProps = toSchema?.type === 'array' ? toSchema.items?.properties : toSchema?.properties;
        if (!fromProps) continue;
        const fromRequiredFields = fromSchema.required ?? (fromSchema.type === 'array' ? (fromSchema.items?.required ?? []) : []);
        for (const prop of Object.keys(fromProps)) {
          const wasRequired = fromRequiredFields.includes(prop);
          if (toProps && !(prop in toProps)) {
            breaking.push({
              type: 'response_property_removed',
              path,
              method: method.toUpperCase(),
              detail: `${wasRequired ? 'Required' : 'Optional'} response property '${prop}' removed from ${statusCode} ${method.toUpperCase()} ${path}`,
            });
          }
        }
      }
    }
  }

  for (const path of Object.keys(toPaths)) {
    if (!(fromSpec.paths ?? {})[path]) {
      nonBreaking.push(`New path added: ${path}`);
    }
  }

  return {
    breaking,
    nonBreaking,
    summary: breaking.length === 0
      ? `No breaking changes. ${nonBreaking.length} additive change(s).`
      : `${breaking.length} breaking change(s) detected.`,
  };
}

// ── Migration guide generation ─────────────────────────────────────────────

export interface AffectedConsumer {
  service: string;
  missingPaths: string[];
  affectedOperations?: string[];
}

export function generateMigrationGuide(
  serviceName: string,
  fromVersion: string,
  toVersion: string,
  breaking: BreakingChange[],
  affectedConsumers: AffectedConsumer[],
): string {
  const lines: string[] = [];
  lines.push(`# Migration Guide: ${serviceName} ${fromVersion} → ${toVersion}`);
  lines.push('');

  if (breaking.length === 0) {
    lines.push('No breaking changes were detected between these versions. No migration steps are required.');
    return lines.join('\n');
  }

  lines.push(`This update introduces **${breaking.length} breaking change(s)**. Consumers depending on the affected paths must update before upgrading.`);
  lines.push('');
  lines.push('## Breaking Changes');
  lines.push('');
  for (const change of breaking) {
    const location = change.method ? `${change.method} ${change.path}` : change.path;
    lines.push(`- **${change.type}** — \`${location}\`: ${change.detail}`);
  }
  lines.push('');

  if (affectedConsumers.length > 0) {
    lines.push('## Affected Consumers');
    lines.push('');
    for (const consumer of affectedConsumers) {
      lines.push(`### ${consumer.service}`);
      lines.push('');
      if (consumer.missingPaths.length > 0) {
        lines.push(`Currently depends on path(s) no longer satisfied by ${serviceName}@${toVersion}:`);
        for (const path of consumer.missingPaths) {
          lines.push(`- \`${path}\``);
        }
        lines.push('');
      }
      if (consumer.affectedOperations && consumer.affectedOperations.length > 0) {
        lines.push(`Depends on operation(s) with breaking changes in ${serviceName}@${toVersion}:`);
        for (const op of consumer.affectedOperations) {
          lines.push(`- \`${op}\``);
        }
        lines.push('');
      }
    }
  } else {
    lines.push('No currently registered consumers were found to be affected, but any unregistered or external callers of the removed/changed paths should be reviewed.');
    lines.push('');
  }

  lines.push('## Checklist');
  lines.push('');
  lines.push('- [ ] Update consumer code to stop using removed paths/methods, or supply newly required parameters');
  lines.push('- [ ] Regenerate consumer-driven contract tests with `generate_contract_tests`');
  lines.push('- [ ] Re-run `validate_compatibility` against the new provider version before merging');
  lines.push('- [ ] Coordinate a deploy order with affected consumer teams');

  return lines.join('\n');
}
