import type { ActionContext } from '@backstage/plugin-scaffolder-node';

// Both exec (promisified for isHelmReleaseDeployed) and execFile (promisified
// for every other kubectl/helm call) come from 'child_process' in the module
// under test, so both callback-style mocks are needed.
const mockExec = jest.fn();
const mockExecFile = jest.fn();
jest.mock('child_process', () => ({
  exec: (...args: any[]) => mockExec(...args),
  execFile: (...args: any[]) => mockExecFile(...args),
}));

const mockEnsureKubeconfig = jest.fn();
jest.mock('../kubeconfig', () => ({
  ensureKubeconfig: (...args: any[]) => mockEnsureKubeconfig(...args),
  kubeEnv: {},
}));

const mockWriteSecureTempFile = jest.fn();
const mockCleanupSecureTempDir = jest.fn();
jest.mock('../secureTempFile', () => ({
  writeSecureTempFile: (...args: any[]) => mockWriteSecureTempFile(...args),
  cleanupSecureTempDir: (...args: any[]) => mockCleanupSecureTempDir(...args),
}));

import { createSetupContractTestingAction } from '../idpSetupContractTesting';

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

/** `helm status ... || echo "{}"` — a not-deployed release by default. */
function mockHelmStatus(deployed: boolean) {
  mockExec.mockImplementation((_cmd: string, _opts: any, cb: any) =>
    cb(null, { stdout: deployed ? JSON.stringify({ info: { status: 'deployed' } }) : '{}', stderr: '' }),
  );
}

function succeedAllExecFile() {
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => cb(null, { stdout: '', stderr: '' }));
}

/** The MCP server's SSE-shaped response, wrapping a JSON-stringified tool result. */
function mcpSseResponse(result: Record<string, unknown>) {
  return `event: message\ndata: ${JSON.stringify({ result: { content: [{ text: JSON.stringify(result) }] } })}\n\n`;
}

function mockHealthAndFetch(opts: { healthOk: boolean; mcpResult?: Record<string, unknown> }) {
  global.fetch = jest.fn().mockImplementation(async (url: string) => {
    if (String(url).endsWith('/healthz')) {
      if (!opts.healthOk) throw new Error('not ready');
      return { ok: true, status: 200, text: async () => '' };
    }
    // /mcp tool call
    return { ok: true, status: 200, text: async () => mcpSseResponse(opts.mcpResult ?? {}) };
  }) as unknown as typeof fetch;
}

describe('idp:setup-contract-testing', () => {
  const action = createSetupContractTestingAction();

  beforeEach(() => {
    mockExec.mockReset();
    mockExecFile.mockReset();
    mockEnsureKubeconfig.mockReset().mockResolvedValue(undefined);
    mockWriteSecureTempFile.mockReset().mockImplementation(async (_prefix: string, filename: string, contents: string) => ({
      dir: `/tmp/mock-${filename}`,
      filePath: `/tmp/mock-${filename}/${filename}`,
      __contents: contents,
    }));
    mockCleanupSecureTempDir.mockReset().mockResolvedValue(undefined);
  });

  it('bootstraps the kubeconfig and wraps a cluster-unreachable failure', async () => {
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) => {
      if (args[0] === 'cluster-info') return cb(new Error('connection refused'));
      return cb(null, { stdout: '', stderr: '' });
    });
    const { ctx } = makeCtx({ targetService: 'hello-service' });
    await expect(action.handler(ctx)).rejects.toThrow('Cannot reach the Kubernetes cluster: connection refused');
    expect(mockEnsureKubeconfig).toHaveBeenCalledTimes(1);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('skips the Helm install when skipDeploy is true, even if not already deployed', async () => {
    succeedAllExecFile();
    mockHelmStatus(false);
    mockHealthAndFetch({ healthOk: true, mcpResult: {} });
    const { ctx } = makeCtx({ targetService: 'hello-service', skipDeploy: true });
    await action.handler(ctx);

    const helmCall = mockExecFile.mock.calls.find(c => c[0] === 'helm');
    expect(helmCall).toBeUndefined();
  });

  it('skips the Helm install when the release is already deployed', async () => {
    succeedAllExecFile();
    mockHelmStatus(true);
    mockHealthAndFetch({ healthOk: true, mcpResult: {} });
    const { ctx } = makeCtx({ targetService: 'hello-service' });
    await action.handler(ctx);

    const helmCall = mockExecFile.mock.calls.find(c => c[0] === 'helm');
    expect(helmCall).toBeUndefined();
  });

  it('installs via helm with an args array (not a shell string) when not already deployed', async () => {
    succeedAllExecFile();
    mockHelmStatus(false);
    mockHealthAndFetch({ healthOk: true, mcpResult: {} });
    const { ctx } = makeCtx({ targetService: 'hello-service' });
    await action.handler(ctx);

    const helmCall = mockExecFile.mock.calls.find(c => c[0] === 'helm');
    expect(helmCall).toBeDefined();
    expect(helmCall![1]).toEqual([
      'upgrade', '--install', 'contract-mcp-server', '/helm/service-template',
      '--namespace', 'services-dev', '--create-namespace',
      '--values', '/tmp/mock-values.yaml/values.yaml',
      '--wait', '--timeout', '120s',
    ]);
    expect(mockCleanupSecureTempDir).toHaveBeenCalledWith('/tmp/mock-values.yaml');
  });

  it('applies the contract-assistant Agent CRD via execFile with an args array', async () => {
    succeedAllExecFile();
    mockHelmStatus(true);
    mockHealthAndFetch({ healthOk: true, mcpResult: {} });
    const { ctx } = makeCtx({ targetService: 'hello-service' });
    await action.handler(ctx);

    const applyCall = mockExecFile.mock.calls.find(c => c[0] === 'kubectl' && c[1][0] === 'apply');
    expect(applyCall![1]).toEqual(['apply', '-f', '/tmp/mock-agent.yaml/agent.yaml']);
    expect(mockCleanupSecureTempDir).toHaveBeenCalledWith('/tmp/mock-agent.yaml');
  });

  it('registers the discovered contract and reports its paths', async () => {
    succeedAllExecFile();
    mockHelmStatus(true);
    mockHealthAndFetch({
      healthOk: true,
      mcpResult: { discovered: true, version: '1.2.0', paths: ['/health', '/api/greet'] },
    });
    const { ctx, outputs } = makeCtx({ targetService: 'hello-service' });
    await action.handler(ctx);

    expect(outputs.contractRegistered).toBe('true');
    expect(JSON.parse(outputs.discoveredPaths as string)).toEqual(['/health', '/api/greet']);
  });

  it('reports contractRegistered=false when discovery finds nothing, without throwing', async () => {
    succeedAllExecFile();
    mockHelmStatus(true);
    mockHealthAndFetch({ healthOk: true, mcpResult: { discovered: false } });
    const { ctx, outputs } = makeCtx({ targetService: 'hello-service' });
    await action.handler(ctx);

    expect(outputs.contractRegistered).toBe('false');
    expect(JSON.parse(outputs.discoveredPaths as string)).toEqual([]);
  });

  it('skips contract registration entirely when the health check never succeeds', async () => {
    jest.useFakeTimers({ legacyFakeTimers: false });
    try {
      succeedAllExecFile();
      mockHelmStatus(true);
      mockHealthAndFetch({ healthOk: false });
      const { ctx, outputs } = makeCtx({ targetService: 'hello-service' });

      const pending = action.handler(ctx);
      await jest.advanceTimersByTimeAsync(65_000);
      await pending;

      expect(outputs.contractRegistered).toBe('false');
      expect((ctx.logger.warn as jest.Mock).mock.calls.some(c => String(c[0]).includes('health check timed out'))).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  }, 15_000);

  it('reports the MCP server and agent URLs in the output', async () => {
    succeedAllExecFile();
    mockHelmStatus(true);
    mockHealthAndFetch({ healthOk: true, mcpResult: {} });
    const { ctx, outputs } = makeCtx({ targetService: 'hello-service' });
    await action.handler(ctx);

    expect(outputs.contractServerUrl).toBe('http://contract-mcp-server.idp.local');
    expect(outputs.agentUrl).toBe('http://kagent.idp.local');
  });
});
