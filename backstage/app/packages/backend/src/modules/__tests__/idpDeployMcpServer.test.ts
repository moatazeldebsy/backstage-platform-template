import type { ActionContext } from '@backstage/plugin-scaffolder-node';

// execFile is promisify()'d in the module under test, so the mock must follow
// Node's callback convention: (file, args, options, callback).
const mockExecFile = jest.fn();
jest.mock('child_process', () => ({
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

import { createDeployMcpServerAction } from '../idpDeployMcpServer';

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

function succeedOn(matcher: (args: string[]) => boolean, stdout = '', stderr = '') {
  mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) => {
    if (matcher(args)) cb(null, { stdout, stderr });
    else cb(new Error(`unexpected kubectl invocation: ${args.join(' ')}`));
  });
}

describe('idp:deploy-mcp-server', () => {
  const action = createDeployMcpServerAction();

  beforeEach(() => {
    mockExecFile.mockReset();
    mockEnsureKubeconfig.mockReset().mockResolvedValue(undefined);
    mockWriteSecureTempFile.mockReset().mockImplementation(async (_prefix: string, filename: string) => ({
      dir: '/tmp/mock-secure-dir',
      filePath: `/tmp/mock-secure-dir/${filename}`,
    }));
    mockCleanupSecureTempDir.mockReset().mockResolvedValue(undefined);
  });

  it('checks cluster reachability before writing or applying anything', async () => {
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) => {
      if (args[0] === 'cluster-info') cb(new Error('connection refused'));
      else cb(null, { stdout: '', stderr: '' });
    });

    const { ctx } = makeCtx({ name: 'my-mcp' });
    await expect(action.handler(ctx)).rejects.toThrow('Cannot reach the cluster: connection refused');
    expect(mockWriteSecureTempFile).not.toHaveBeenCalled();
  });

  it('applies the CRD via execFile with an args array, not a shell string', async () => {
    succeedOn(() => true);

    const { ctx, outputs } = makeCtx({ name: 'my-mcp' });
    await action.handler(ctx);

    expect(mockWriteSecureTempFile).toHaveBeenCalledTimes(1);
    const [prefix, filename] = mockWriteSecureTempFile.mock.calls[0];
    expect(prefix).toBe('mcpserver');
    expect(filename).toBe('my-mcp.yaml');

    const applyCall = mockExecFile.mock.calls.find(c => c[1][0] === 'apply');
    expect(applyCall).toBeDefined();
    expect(applyCall![1]).toEqual(['apply', '-f', '/tmp/mock-secure-dir/my-mcp.yaml']);
    expect(typeof applyCall![1]).not.toBe('string');
    expect(outputs.mcpServerName).toBe('my-mcp');
  });

  it('always cleans up the temp directory, even when kubectl apply fails', async () => {
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) => {
      if (args[0] === 'cluster-info') return cb(null, { stdout: '', stderr: '' });
      if (args[0] === 'apply') return cb(new Error('admission webhook denied'));
      return cb(null, { stdout: '', stderr: '' });
    });

    const { ctx } = makeCtx({ name: 'my-mcp' });
    await expect(action.handler(ctx)).rejects.toThrow('admission webhook denied');
    expect(mockCleanupSecureTempDir).toHaveBeenCalledWith('/tmp/mock-secure-dir');
  });

  it('bootstraps the kubeconfig before checking the cluster', async () => {
    succeedOn(() => true);
    const { ctx } = makeCtx({ name: 'my-mcp' });
    await action.handler(ctx);
    expect(mockEnsureKubeconfig).toHaveBeenCalledTimes(1);
  });
});
