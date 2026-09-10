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

import { createCreateNamespaceAction } from '../idpCreateNamespace';

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

describe('idp:create-namespace', () => {
  const action = createCreateNamespaceAction();

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

    const { ctx } = makeCtx({ name: 'scratch-payments' });
    await expect(action.handler(ctx)).rejects.toThrow('Cannot reach the cluster: connection refused');
    expect(mockWriteSecureTempFile).not.toHaveBeenCalled();
  });

  it('writes the manifest to a securely-created temp dir, applies it, and reports the namespace as output', async () => {
    succeedOn(() => true);

    const { ctx, outputs } = makeCtx({ name: 'scratch-payments' });
    await action.handler(ctx);

    expect(mockWriteSecureTempFile).toHaveBeenCalledTimes(1);
    const [prefix, filename] = mockWriteSecureTempFile.mock.calls[0];
    expect(prefix).toBe('namespace');
    expect(filename).toBe('scratch-payments.yaml');

    const applyCall = mockExecFile.mock.calls.find(c => c[1][0] === 'apply');
    expect(applyCall).toBeDefined();
    expect(applyCall![1]).toEqual(['apply', '-f', '/tmp/mock-secure-dir/scratch-payments.yaml']);
    expect(outputs.namespace).toBe('scratch-payments');
  });

  it('bootstraps the kubeconfig before checking the cluster', async () => {
    succeedOn(() => true);
    const { ctx } = makeCtx({ name: 'scratch-payments' });
    await action.handler(ctx);
    expect(mockEnsureKubeconfig).toHaveBeenCalledTimes(1);
  });

  it('always cleans up the temp directory, even when kubectl apply fails', async () => {
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) => {
      if (args[0] === 'cluster-info') return cb(null, { stdout: '', stderr: '' });
      if (args[0] === 'apply') return cb(new Error('admission webhook denied'));
      return cb(null, { stdout: '', stderr: '' });
    });

    const { ctx } = makeCtx({ name: 'scratch-payments' });
    await expect(action.handler(ctx)).rejects.toThrow('admission webhook denied');
    expect(mockCleanupSecureTempDir).toHaveBeenCalledWith('/tmp/mock-secure-dir');
  });

  it('defaults to the small tier with its ResourceQuota', async () => {
    succeedOn(() => true);
    const { ctx } = makeCtx({ name: 'scratch-payments' });
    await action.handler(ctx);

    const yaml = mockWriteSecureTempFile.mock.calls[0][2] as string;
    expect(yaml).toContain('idp.io/tier: small');
    expect(yaml).toContain('kind: ResourceQuota');
    expect(yaml).toContain('requests.cpu: "4"');
    expect(yaml).toContain('limits.memory: 16Gi');
  });

  it('uses the medium tier quota when requested', async () => {
    succeedOn(() => true);
    const { ctx } = makeCtx({ name: 'scratch-payments', tier: 'medium' });
    await action.handler(ctx);

    const yaml = mockWriteSecureTempFile.mock.calls[0][2] as string;
    expect(yaml).toContain('requests.cpu: "16"');
    expect(yaml).toContain('limits.memory: 64Gi');
  });

  it('omits the ResourceQuota entirely for the large tier (no quota defined = unlimited)', async () => {
    succeedOn(() => true);
    const { ctx } = makeCtx({ name: 'scratch-payments', tier: 'large' });
    await action.handler(ctx);

    const yaml = mockWriteSecureTempFile.mock.calls[0][2] as string;
    expect(yaml).toContain('idp.io/tier: large');
    expect(yaml).not.toContain('kind: ResourceQuota');
  });

  it('applies the default-deny NetworkPolicy unless explicitly disabled', async () => {
    succeedOn(() => true);
    const { ctx } = makeCtx({ name: 'scratch-payments' });
    await action.handler(ctx);
    expect(mockWriteSecureTempFile.mock.calls[0][2] as string).toContain('kind: NetworkPolicy');
  });

  it('omits the NetworkPolicy when networkPolicy: false', async () => {
    succeedOn(() => true);
    const { ctx } = makeCtx({ name: 'scratch-payments', networkPolicy: false });
    await action.handler(ctx);
    expect(mockWriteSecureTempFile.mock.calls[0][2] as string).not.toContain('kind: NetworkPolicy');
  });

  it('always sets restricted Pod Security Standards labels, regardless of tier', async () => {
    succeedOn(() => true);
    const { ctx } = makeCtx({ name: 'scratch-payments', tier: 'large' });
    await action.handler(ctx);

    const yaml = mockWriteSecureTempFile.mock.calls[0][2] as string;
    expect(yaml).toContain('pod-security.kubernetes.io/enforce: restricted');
    expect(yaml).toContain('pod-security.kubernetes.io/audit: restricted');
    expect(yaml).toContain('pod-security.kubernetes.io/warn: restricted');
  });
});
