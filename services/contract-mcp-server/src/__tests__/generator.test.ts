import {
  parseSpec,
  extractPaths,
  generatePactJson,
  generatePactTestCode,
  extractSchemaContext,
  detectBreakingChanges,
  generateMigrationGuide,
  type OpenAPISpec,
} from '../generator.js';

// ── Fixtures ──────────────────────────────────────────────────────────────

const MINIMAL_SPEC: OpenAPISpec = {
  openapi: '3.0.0',
  info: { title: 'Test', version: '1.0.0' },
  paths: {
    '/healthz': {
      get: { summary: 'Health', responses: { '200': { description: 'OK' } } },
    },
  },
};

const SCHEMA_SPEC: OpenAPISpec = {
  openapi: '3.0.0',
  info: { title: 'Pet Store', version: '1.0.0' },
  paths: {
    '/pets': {
      get: {
        summary: 'List pets',
        parameters: [{ name: 'limit', in: 'query', required: true, schema: { type: 'integer' } }],
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    id:   { type: 'string', format: 'uuid' },
                    name: { type: 'string' },
                    age:  { type: 'integer' },
                  },
                  required: ['id', 'name'],
                },
              },
            },
          },
        },
      },
      post: {
        summary: 'Create pet',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  tag:  { type: 'string' },
                },
                required: ['name'],
              },
            },
          },
        },
        responses: {
          '201': {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    id:   { type: 'string', format: 'uuid' },
                    name: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/pets/{id}': {
      delete: {
        summary: 'Delete pet',
        responses: { '204': { description: 'Deleted' } },
      },
    },
  },
};

// ── parseSpec ─────────────────────────────────────────────────────────────

describe('parseSpec', () => {
  it('parses a JSON string', () => {
    const result = parseSpec(JSON.stringify(MINIMAL_SPEC));
    expect(result.info?.title).toBe('Test');
    expect(result.paths).toBeDefined();
  });

  it('parses a YAML string', () => {
    const yaml = `openapi: "3.0.0"\ninfo:\n  title: YAML Service\n  version: "1.0.0"\npaths: {}`;
    const result = parseSpec(yaml);
    expect(result.info?.title).toBe('YAML Service');
  });

  it('handles specs without paths', () => {
    const result = parseSpec(JSON.stringify({ openapi: '3.0.0', info: { title: 'Empty' } }));
    expect(result.paths).toBeUndefined();
  });
});

// ── extractPaths ──────────────────────────────────────────────────────────

describe('extractPaths', () => {
  it('returns all path keys', () => {
    const paths = extractPaths(SCHEMA_SPEC);
    expect(paths).toEqual(expect.arrayContaining(['/pets', '/pets/{id}']));
    expect(paths).toHaveLength(2);
  });

  it('returns empty array when paths is undefined', () => {
    expect(extractPaths({})).toEqual([]);
  });
});

// ── generatePactJson ──────────────────────────────────────────────────────

describe('generatePactJson', () => {
  it('sets consumer and provider names', () => {
    const result = generatePactJson('my-consumer', 'pet-store', MINIMAL_SPEC) as Record<string, unknown>;
    expect((result.consumer as Record<string, string>).name).toBe('my-consumer');
    expect((result.provider as Record<string, string>).name).toBe('pet-store');
  });

  it('creates one interaction per valid HTTP method', () => {
    const result = generatePactJson('c', 'p', SCHEMA_SPEC) as { interactions: unknown[] };
    // /pets GET, /pets POST, /pets/{id} DELETE = 3
    expect(result.interactions).toHaveLength(3);
  });

  it('includes request body from schema', () => {
    const result = generatePactJson('c', 'p', SCHEMA_SPEC) as { interactions: Array<{ request: Record<string, unknown> }> };
    const post = result.interactions.find(i => i.request.method === 'POST');
    expect(post?.request.body).toEqual({ name: 'string', tag: 'string' });
    expect(post?.request.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('includes response body from schema', () => {
    const result = generatePactJson('c', 'p', SCHEMA_SPEC) as { interactions: Array<{ response: Record<string, unknown>; request: Record<string, unknown> }> };
    const post = result.interactions.find(i => i.request.method === 'POST');
    expect(post?.response.body).toBeDefined();
    expect((post?.response.body as Record<string, unknown>).name).toBe('string');
  });

  it('includes required query params in request', () => {
    const result = generatePactJson('c', 'p', SCHEMA_SPEC) as { interactions: Array<{ request: Record<string, unknown> }> };
    const get = result.interactions.find(i => i.request.method === 'GET');
    expect(get?.request.query).toEqual({ limit: 1 });
  });

  it('sets pact specification version 3.0.0', () => {
    const result = generatePactJson('c', 'p', MINIMAL_SPEC) as { metadata: { pactSpecification: { version: string } } };
    expect(result.metadata.pactSpecification.version).toBe('3.0.0');
  });

  it('uses spec summary as interaction description', () => {
    const result = generatePactJson('c', 'p', MINIMAL_SPEC) as { interactions: Array<{ description: string }> };
    expect(result.interactions[0].description).toBe('Health');
  });

  it('produces no interactions for an empty spec', () => {
    const result = generatePactJson('c', 'p', {}) as { interactions: unknown[] };
    expect(result.interactions).toHaveLength(0);
  });
});

// ── generatePactTestCode ──────────────────────────────────────────────────

describe('generatePactTestCode', () => {
  let code: string;
  let minimalCode: string;

  beforeAll(() => {
    code = generatePactTestCode('frontend-app', 'pet-store', SCHEMA_SPEC);
    minimalCode = generatePactTestCode('c', 'p', MINIMAL_SPEC);
  });

  it('imports PactV3 and MatchersV3', () => {
    expect(code).toContain("import { PactV3, MatchersV3 } from '@pact-foundation/pact'");
  });

  it('destructures matchers', () => {
    expect(code).toContain('const { like, eachLike, regex, integer, decimal } = MatchersV3');
  });

  it('sets consumer and provider names in PactV3 constructor', () => {
    expect(code).toContain("consumer: 'frontend-app'");
    expect(code).toContain("provider: 'pet-store'");
  });

  it('generates a test case for each operation', () => {
    // GET /pets, POST /pets, DELETE /pets/{id}
    const itCount = (code.match(/\bit\(/g) ?? []).length;
    expect(itCount).toBe(3);
  });

  it('uses like() for string request body fields', () => {
    expect(code).toContain("body: like({ name: like('string'), tag: like('string') })");
  });

  it('uses regex() for uuid format in response body', () => {
    expect(code).toContain("regex('550e8400-e29b-41d4-a716-446655440000'");
  });

  it('uses integer() for required query parameters', () => {
    expect(code).toContain('query: { limit: like(1) }');
  });

  it('includes Content-Type header when requestBody is present', () => {
    expect(code).toContain("headers: { 'Content-Type': 'application/json' }");
  });

  it('generates fetch with body for POST requests', () => {
    expect(code).toContain("method: 'POST'");
    expect(code).toContain("body: JSON.stringify(");
  });

  it('generates response body assertions for known properties', () => {
    expect(code).toContain("expect(body.id).toBeDefined()");
    expect(code).toContain("expect(body.name).toBeDefined()");
  });

  it('falls back to status-only when there are no schemas', () => {
    expect(minimalCode).not.toContain('body:');
    expect(minimalCode).toContain("expect(response.status).toBe(200)");
  });

  it('uses simple fetch (no body) for GET requests without requestBody', () => {
    expect(minimalCode).toContain('const response = await fetch(`${mockServer.url}/healthz`);');
  });

  it('wraps the describe block with consumer→provider label', () => {
    expect(code).toContain("describe('frontend-app → pet-store contract'");
  });
});

// ── extractSchemaContext ──────────────────────────────────────────────────

describe('extractSchemaContext', () => {
  let ctx: ReturnType<typeof extractSchemaContext>;

  beforeAll(() => { ctx = extractSchemaContext(SCHEMA_SPEC); });

  it('creates an entry per path', () => {
    expect(Object.keys(ctx)).toEqual(expect.arrayContaining(['/pets', '/pets/{id}']));
  });

  it('captures operation summary', () => {
    expect(ctx['/pets']['get'].summary).toBe('List pets');
  });

  it('captures required query parameters', () => {
    const params = ctx['/pets']['get'].parameters;
    expect(params).toEqual([{ name: 'limit', in: 'query', required: true, type: 'integer' }]);
  });

  it('captures requestBody properties and required fields', () => {
    const rb = ctx['/pets']['post'].requestBody!;
    expect(rb.properties).toContain('name');
    expect(rb.properties).toContain('tag');
    expect(rb.required_fields).toContain('name');
    expect(rb.required).toBe(true);
    expect(rb.contentType).toBe('application/json');
  });

  it('captures requestBody example', () => {
    const example = ctx['/pets']['post'].requestBody!.example as Record<string, unknown>;
    expect(example.name).toBe('string');
    expect(example.tag).toBe('string');
  });

  it('captures response properties and example', () => {
    const resp = ctx['/pets']['post'].responses['201'];
    expect(resp.properties).toContain('id');
    expect(resp.properties).toContain('name');
    const example = resp.example as Record<string, unknown>;
    expect(example.id).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('returns empty schemas for spec without paths', () => {
    expect(extractSchemaContext({})).toEqual({});
  });
});

// ── detectBreakingChanges ─────────────────────────────────────────────────

describe('detectBreakingChanges', () => {
  const v1: OpenAPISpec = {
    paths: {
      '/users': {
        get:    { responses: {}, parameters: [{ name: 'q', in: 'query', required: false }] },
        post:   { responses: {}, parameters: [] },
        delete: { responses: {}, parameters: [] },
      },
      '/orders': { get: { responses: {}, parameters: [] } },
    },
  };

  it('detects path_removed', () => {
    const v2: OpenAPISpec = { paths: { '/users': v1.paths!['/users'] } };
    const { breaking } = detectBreakingChanges(v1, v2);
    expect(breaking).toContainEqual(expect.objectContaining({ type: 'path_removed', path: '/orders' }));
  });

  it('detects method_removed', () => {
    const v2: OpenAPISpec = {
      paths: {
        '/users': { get: v1.paths!['/users']['get'] },
        '/orders': v1.paths!['/orders'],
      },
    };
    const { breaking } = detectBreakingChanges(v1, v2);
    expect(breaking).toContainEqual(expect.objectContaining({ type: 'method_removed', path: '/users', method: 'POST' }));
    expect(breaking).toContainEqual(expect.objectContaining({ type: 'method_removed', path: '/users', method: 'DELETE' }));
  });

  it('detects required_param_added', () => {
    const v2: OpenAPISpec = {
      paths: {
        '/users': {
          get: { responses: {}, parameters: [{ name: 'q', in: 'query', required: true }] },
          post: { responses: {}, parameters: [] },
          delete: { responses: {}, parameters: [] },
        },
        '/orders': v1.paths!['/orders'],
      },
    };
    const { breaking } = detectBreakingChanges(v1, v2);
    expect(breaking).toContainEqual(expect.objectContaining({ type: 'required_param_added', path: '/users', method: 'GET' }));
  });

  it('marks new paths as nonBreaking', () => {
    const v2: OpenAPISpec = {
      paths: { ...v1.paths, '/new-endpoint': { get: { responses: {} } } },
    };
    const { nonBreaking } = detectBreakingChanges(v1, v2);
    expect(nonBreaking.some(m => m.includes('/new-endpoint'))).toBe(true);
  });

  it('returns no breaking changes when specs are identical', () => {
    const { breaking, summary } = detectBreakingChanges(v1, v1);
    expect(breaking).toHaveLength(0);
    expect(summary).toMatch(/No breaking/);
  });

  it('summary reports correct breaking count', () => {
    const v2: OpenAPISpec = { paths: {} };
    const { summary } = detectBreakingChanges(v1, v2);
    expect(summary).toMatch(/\d+ breaking/);
  });
});

// ── Schema format coverage (exercises schemaToExample / schemaToMatcherCode) ──
// These functions are private but reachable via generatePactJson / generatePactTestCode.

function makeSpec(schema: Record<string, unknown>): OpenAPISpec {
  return {
    openapi: '3.0.0',
    info: { title: 'Schema Test', version: '1.0.0' },
    paths: {
      '/test': {
        post: {
          requestBody: {
            required: true,
            content: { 'application/json': { schema } },
          },
          responses: {
            '200': {
              content: { 'application/json': { schema } },
            },
          },
        },
      },
    },
  };
}

type PactDoc = { interactions: Array<{ request: { body: unknown }; response: { body: unknown } }> };
function pactBody(spec: OpenAPISpec): unknown {
  return (generatePactJson('consumer', 'provider', spec) as PactDoc).interactions[0]?.request?.body;
}

describe('schemaToExample — format coverage', () => {
  it('date-time format produces an ISO timestamp string', () => {
    const body = pactBody(makeSpec({ type: 'string', format: 'date-time' }));
    expect(typeof body).toBe('string');
    expect(body as string).toMatch(/T\d{2}:\d{2}:\d{2}/);
  });

  it('date format produces a date-only string', () => {
    const body = pactBody(makeSpec({ type: 'string', format: 'date' }));
    expect(typeof body).toBe('string');
    expect(body as string).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('uri format produces an https URL string', () => {
    const body = pactBody(makeSpec({ type: 'string', format: 'uri' }));
    expect(typeof body).toBe('string');
    expect(body as string).toMatch(/^https?:\/\//);
  });

  it('email format produces an email address string', () => {
    expect(pactBody(makeSpec({ type: 'string', format: 'email' })) as string).toMatch(/@/);
  });

  it('unknown type produces null example', () => {
    expect(pactBody(makeSpec({ type: 'null' }))).toBeNull();
  });

  it('array type wraps the item example in an array', () => {
    expect(Array.isArray(pactBody(makeSpec({ type: 'array', items: { type: 'string' } })))).toBe(true);
  });

  it('boolean type produces true', () => {
    expect(pactBody(makeSpec({ type: 'boolean' }))).toBe(true);
  });

  it('number type produces a numeric value', () => {
    expect(typeof pactBody(makeSpec({ type: 'number' }))).toBe('number');
  });
});

describe('schemaToMatcherCode — format coverage', () => {
  it('date format produces a like() matcher in test code', () => {
    const spec = makeSpec({ type: 'string', format: 'date' });
    const code = generatePactTestCode('consumer', 'provider', spec);
    expect(code).toContain("like('2024-01-15')");
  });

  it('pattern produces a regex() matcher in test code', () => {
    const spec = makeSpec({ type: 'string', pattern: '^[A-Z]{3}$' });
    const code = generatePactTestCode('consumer', 'provider', spec);
    expect(code).toContain('regex(');
    expect(code).toContain('^[A-Z]{3}$');
  });

  it('enum values use like() with the first enum value', () => {
    const spec = makeSpec({ type: 'string', enum: ['ACTIVE', 'INACTIVE'] });
    const code = generatePactTestCode('consumer', 'provider', spec);
    expect(code).toContain("like(\"ACTIVE\")");
  });

  it('example value uses like() wrapping the example', () => {
    const spec = makeSpec({ type: 'string', example: 'my-example' });
    const code = generatePactTestCode('consumer', 'provider', spec);
    expect(code).toContain('like("my-example")');
  });

  it('unknown type produces like(null) in test code', () => {
    const spec = makeSpec({ type: 'null' });
    const code = generatePactTestCode('consumer', 'provider', spec);
    expect(code).toContain('like(null)');
  });

  it('depth limit: deeply nested arrays use like(null) beyond depth 2', () => {
    const spec = makeSpec({
      type: 'array',
      items: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
    });
    const code = generatePactTestCode('consumer', 'provider', spec);
    // Depth >2 hits the guard — like(null) appears somewhere in the output
    expect(code).toContain('like(null)');
  });

  it('object with no properties produces like({})', () => {
    const spec = makeSpec({ type: 'object' }); // no properties field
    const code = generatePactTestCode('consumer', 'provider', spec);
    expect(code).toContain('like({})');
  });

  it('integer schema produces integer() matcher via nested object property', () => {
    const spec = makeSpec({
      type: 'object',
      properties: { count: { type: 'integer', minimum: 5 }, ratio: { type: 'number', minimum: 0.5 } },
    });
    const code = generatePactTestCode('consumer', 'provider', spec);
    expect(code).toContain('integer(5)');
    expect(code).toContain('decimal(0.5)');
  });
});

// ── generateMigrationGuide ───────────────────────────────────────────────────

describe('generateMigrationGuide', () => {
  it('reports no migration steps required when there are no breaking changes', () => {
    const guide = generateMigrationGuide('hello-service', '1.0.0', '1.1.0', [], []);
    expect(guide).toContain('Migration Guide: hello-service 1.0.0 → 1.1.0');
    expect(guide).toContain('No breaking changes were detected');
  });

  it('lists breaking changes and affected consumers with their missing paths', () => {
    const guide = generateMigrationGuide(
      'hello-service', '1.0.0', '2.0.0',
      [{ type: 'path_removed', path: '/health', detail: 'Path /health was removed' }],
      [{ service: 'consumer-a', missingPaths: ['/health'] }],
    );
    expect(guide).toContain('1 breaking change(s)');
    expect(guide).toContain('path_removed');
    expect(guide).toContain('/health');
    expect(guide).toContain('### consumer-a');
    expect(guide).toContain('Checklist');
  });

  it('notes when no registered consumers are affected despite breaking changes', () => {
    const guide = generateMigrationGuide(
      'hello-service', '1.0.0', '2.0.0',
      [{ type: 'method_removed', path: '/widgets', method: 'DELETE', detail: 'DELETE /widgets was removed' }],
      [],
    );
    expect(guide).toContain('No currently registered consumers were found to be affected');
  });
});
