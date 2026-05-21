import yaml from 'js-yaml';

export interface OpenAPISpec {
  openapi?: string;
  swagger?: string;
  info?: { title?: string; version?: string; description?: string };
  paths?: Record<string, Record<string, OpenAPIOperation>>;
  components?: Record<string, unknown>;
}

interface OpenAPIOperation {
  summary?: string;
  description?: string;
  operationId?: string;
  parameters?: Array<{ name: string; in: string; required?: boolean }>;
  requestBody?: { required?: boolean; content?: Record<string, unknown> };
  responses?: Record<string, { description?: string; content?: Record<string, unknown> }>;
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

export interface PactInteraction {
  description: string;
  providerStates?: Array<{ name: string }>;
  request: { method: string; path: string; headers?: Record<string, string> };
  response: { status: number; headers?: Record<string, string> };
}

export function generatePactJson(consumerName: string, providerName: string, spec: OpenAPISpec): object {
  const interactions: PactInteraction[] = [];

  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(methods)) {
      if (!['get', 'post', 'put', 'delete', 'patch', 'head'].includes(method)) continue;
      const op = operation as OpenAPIOperation;
      const successCode = Object.keys(op.responses ?? {}).find(c => c.startsWith('2')) ?? '200';
      interactions.push({
        description: op.summary ?? `${method.toUpperCase()} ${path}`,
        providerStates: [{ name: `${providerName} is available` }],
        request: { method: method.toUpperCase(), path },
        response: { status: parseInt(successCode, 10) },
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

export function generatePactTestCode(consumerName: string, providerName: string, spec: OpenAPISpec): string {
  const interactions: string[] = [];

  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(methods)) {
      if (!['get', 'post', 'put', 'delete', 'patch'].includes(method)) continue;
      const op = operation as OpenAPIOperation;
      const desc = op.summary ?? `${method.toUpperCase()} ${path}`;
      const successCode = Object.keys(op.responses ?? {}).find(c => c.startsWith('2')) ?? '200';
      interactions.push(`
  it('${desc.replace(/'/g, "\\'")}', async () => {
    await provider
      .given('${providerName} is available')
      .uponReceiving('a request to ${method.toUpperCase()} ${path}')
      .withRequest({ method: '${method.toUpperCase()}', path: '${path}' })
      .willRespondWith({ status: ${successCode} })
      .executeTest(async (mockServer) => {
        const response = await fetch(\`\${mockServer.url}${path}\`);
        expect(response.status).toBe(${successCode});
      });
  });`);
    }
  }

  return `import { PactV3 } from '@pact-foundation/pact';
import * as path from 'path';

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
  type: 'path_removed' | 'method_removed' | 'required_param_added';
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
      if (!['get', 'post', 'put', 'delete', 'patch'].includes(method)) continue;
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
    }
  }

  // New paths are non-breaking additions
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
