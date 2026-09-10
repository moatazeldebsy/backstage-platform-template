import type { ActionContext } from '@backstage/plugin-scaffolder-node';

// exec is promisify()'d in the module under test — every command is a single
// shell string, not execFile's array form, so the mock follows Node's
// callback convention for exec: (command, options, callback).
const mockExec = jest.fn();
jest.mock('child_process', () => ({
  exec: (...args: any[]) => mockExec(...args),
}));

const mockMkdir = jest.fn();
const mockWriteFile = jest.fn();
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    promises: {
      ...actual.promises,
      mkdir: (...args: any[]) => mockMkdir(...args),
      writeFile: (...args: any[]) => mockWriteFile(...args),
    },
  };
});

import {
  createDeployLocalAction,
  createSeedImageAction,
  createCatalogRegisterLocalAction,
} from '../idpLocalDeploy';

function makeCtx(input: Record<string, unknown>) {
  const outputs: Record<string, unknown> = {};
  const ctx = {
    input,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    output: (name: string, value: unknown) => {
      outputs[name] = value;
    },
  } as unknown as ActionContext<any, any, any>;
  return { ctx, outputs };
}

function succeedAllExec() {
  mockExec.mockImplementation((_cmd: string, _opts: any, cb: any) => cb(null, { stdout: '', stderr: '' }));
}

describe('idp:deploy-local', () => {
  const action = createDeployLocalAction();

  beforeEach(() => {
    mockExec.mockReset();
  });

  it('throws a clear error when helm is not available, before checking the cluster', async () => {
    mockExec.mockImplementation((cmd: string, _opts: any, cb: any) => {
      if (cmd.startsWith('helm version')) return cb(new Error('command not found'));
      return cb(null, { stdout: '', stderr: '' });
    });
    const { ctx } = makeCtx({ serviceName: 'hello-service' });
    await expect(action.handler(ctx)).rejects.toThrow(/helm is not available/);
    expect(mockExec.mock.calls.some(c => String(c[0]).includes('cluster-info'))).toBe(false);
  });

  it('throws a clear error mentioning KUBECONFIG when the cluster is unreachable', async () => {
    mockExec.mockImplementation((cmd: string, _opts: any, cb: any) => {
      if (cmd.startsWith('helm version')) return cb(null, { stdout: 'v3.17.3', stderr: '' });
      if (cmd.includes('cluster-info')) return cb(new Error('connection refused'));
      return cb(null, { stdout: '', stderr: '' });
    });
    const { ctx } = makeCtx({ serviceName: 'hello-service' });
    await expect(action.handler(ctx)).rejects.toThrow(/Cannot reach the Kind cluster \(KUBECONFIG=/);
  });

  it('runs helm upgrade --install with the resolved image repository and tag, and reports the service URL', async () => {
    succeedAllExec();
    const { ctx, outputs } = makeCtx({ serviceName: 'hello-service', imageTag: 'abc123' });
    await action.handler(ctx);

    const helmCall = mockExec.mock.calls.find(c => String(c[0]).startsWith('helm upgrade --install'));
    expect(helmCall).toBeDefined();
    expect(helmCall![0]).toContain('--set image.repository=localhost:5003/hello-service');
    expect(helmCall![0]).toContain('--set image.tag=abc123');
    expect(helmCall![0]).toContain('--namespace services');

    expect(outputs.serviceUrl).toBe('http://hello-service.idp.local');
    expect(outputs.releaseStatus).toBe('deployed');
  });

  it('does not fail the action when fetching pod status afterwards fails', async () => {
    mockExec.mockImplementation((cmd: string, _opts: any, cb: any) => {
      if (cmd.includes('get pods')) return cb(new Error('kubectl not found'));
      return cb(null, { stdout: '', stderr: '' });
    });
    const { ctx } = makeCtx({ serviceName: 'hello-service' });
    await expect(action.handler(ctx)).resolves.toBeUndefined();
    expect((ctx.logger.warn as jest.Mock).mock.calls.some(c => String(c[0]).includes('Could not fetch pod status'))).toBe(true);
  });

  it('honours a custom namespace, registry, and helm chart path', async () => {
    succeedAllExec();
    const { ctx } = makeCtx({
      serviceName: 'hello-service',
      namespace: 'services-dev',
      registry: 'ghcr.io/acme',
      helmChartPath: '/custom/chart',
    });
    await action.handler(ctx);

    const helmCall = mockExec.mock.calls.find(c => String(c[0]).startsWith('helm upgrade --install'));
    expect(helmCall![0]).toContain('/custom/chart');
    expect(helmCall![0]).toContain('--namespace services-dev');
    expect(helmCall![0]).toContain('--set image.repository=ghcr.io/acme/hello-service');
  });
});

describe('idp:seed-image', () => {
  const action = createSeedImageAction();

  beforeEach(() => {
    mockExec.mockReset();
  });

  it('pulls, tags, and pushes the placeholder image via the host.docker.internal registry', async () => {
    succeedAllExec();
    const { ctx } = makeCtx({ serviceName: 'payments-api' });
    await action.handler(ctx);

    const cmds = mockExec.mock.calls.map(c => c[0] as string);
    expect(cmds[0]).toBe('docker pull host.docker.internal:5003/hello-service:local');
    expect(cmds[1]).toBe('docker tag host.docker.internal:5003/hello-service:local host.docker.internal:5003/payments-api:latest');
    expect(cmds[2]).toBe('docker push host.docker.internal:5003/payments-api:latest');
  });

  it('does not fail the action when the Docker socket is unavailable — logs a manual fallback', async () => {
    mockExec.mockImplementation((_cmd: string, _opts: any, cb: any) => cb(new Error('docker: command not found')));
    const { ctx } = makeCtx({ serviceName: 'payments-api' });
    await expect(action.handler(ctx)).resolves.toBeUndefined();
    expect((ctx.logger.warn as jest.Mock).mock.calls.some(c => String(c[0]).includes('Could not seed image'))).toBe(true);
  });

  it('honours a custom registry and source image', async () => {
    succeedAllExec();
    const { ctx } = makeCtx({ serviceName: 'payments-api', registry: 'localhost:9999', sourceImage: 'base:v1' });
    await action.handler(ctx);
    const cmds = mockExec.mock.calls.map(c => c[0] as string);
    expect(cmds[0]).toBe('docker pull host.docker.internal:9999/base:v1');
  });
});

describe('idp:catalog-register-local', () => {
  const action = createCatalogRegisterLocalAction();

  beforeEach(() => {
    mockMkdir.mockReset().mockResolvedValue(undefined);
    mockWriteFile.mockReset().mockResolvedValue(undefined);
  });

  it('writes catalog-info.yaml with the resolved defaults and registers it with the catalog API', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 201, text: async () => '' }) as unknown as typeof fetch;

    const { ctx, outputs } = makeCtx({ entityName: 'payments-api' });
    await action.handler(ctx);

    expect(mockMkdir).toHaveBeenCalledWith('/catalog/scaffolded/payments-api', { recursive: true });
    const [writtenPath, yaml] = mockWriteFile.mock.calls[0];
    expect(writtenPath).toBe('/catalog/scaffolded/payments-api/catalog-info.yaml');
    expect(yaml).toContain('kind: Component');
    expect(yaml).toContain('name: payments-api');
    expect(yaml).toContain('owner: platform-team');

    expect(outputs.entityRef).toBe('component:default/payments-api');
    expect(outputs.catalogInfoPath).toBe('/catalog/scaffolded/payments-api/catalog-info.yaml');

    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:7007/api/catalog/locations',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('includes annotations and description in the written YAML when given', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 201, text: async () => '' }) as unknown as typeof fetch;
    const { ctx } = makeCtx({
      entityName: 'payments-api',
      description: 'Handles payments',
      annotations: { 'github.com/project-slug': 'acme/payments-api' },
    });
    await action.handler(ctx);
    const yaml = mockWriteFile.mock.calls[0][1] as string;
    expect(yaml).toContain('description: "Handles payments"');
    expect(yaml).toContain('github.com/project-slug: "acme/payments-api"');
  });

  it('treats a 409 (already registered) as success, not a warning', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 409, text: async () => 'exists' }) as unknown as typeof fetch;
    const { ctx } = makeCtx({ entityName: 'payments-api' });
    await action.handler(ctx);
    expect((ctx.logger.info as jest.Mock).mock.calls.some(c => String(c[0]).includes('Registered catalog location (status=409)'))).toBe(true);
    expect(ctx.logger.warn).not.toHaveBeenCalled();
  });

  it('warns but does not throw on a non-ok, non-409 catalog API response', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'server error' }) as unknown as typeof fetch;
    const { ctx } = makeCtx({ entityName: 'payments-api' });
    await expect(action.handler(ctx)).resolves.toBeUndefined();
    expect((ctx.logger.warn as jest.Mock).mock.calls.some(c => String(c[0]).includes('Catalog location POST returned 500'))).toBe(true);
  });

  it('does not fail the action when the catalog API is entirely unreachable', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    const { ctx } = makeCtx({ entityName: 'payments-api' });
    await expect(action.handler(ctx)).resolves.toBeUndefined();
    expect((ctx.logger.warn as jest.Mock).mock.calls.some(c => String(c[0]).includes('Could not POST catalog location'))).toBe(true);
  });
});
