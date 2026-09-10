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

import { createRunTrainingJobAction } from '../idpRunTrainingJob';

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

describe('idp:run-training-job', () => {
  const action = createRunTrainingJobAction();
  const originalBackend = process.env.IDP_TRAINING_BACKEND;

  beforeEach(() => {
    // Forces the Job fallback path (no Argo Workflows CRD lookup), keeping
    // these tests focused on the execFile/temp-file hardening rather than the
    // Job-vs-Workflow branching, which is covered elsewhere.
    process.env.IDP_TRAINING_BACKEND = 'job';
    mockExecFile.mockReset();
    mockEnsureKubeconfig.mockReset().mockResolvedValue(undefined);
    mockWriteSecureTempFile.mockReset().mockImplementation(async (_prefix: string, filename: string) => ({
      dir: '/tmp/mock-secure-dir',
      filePath: `/tmp/mock-secure-dir/${filename}`,
    }));
    mockCleanupSecureTempDir.mockReset().mockResolvedValue(undefined);
  });

  afterAll(() => {
    if (originalBackend === undefined) delete process.env.IDP_TRAINING_BACKEND;
    else process.env.IDP_TRAINING_BACKEND = originalBackend;
  });

  it('checks cluster reachability before writing or applying anything', async () => {
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) => {
      if (args[0] === 'cluster-info') cb(new Error('connection refused'));
      else cb(null, { stdout: '', stderr: '' });
    });

    const { ctx } = makeCtx({ name: 'my-experiment', experimentName: 'exp-1' });
    await expect(action.handler(ctx)).rejects.toThrow('Cannot reach the Kubernetes cluster: connection refused');
    expect(mockWriteSecureTempFile).not.toHaveBeenCalled();
  });

  it('submits the Job manifest via execFile with an args array, not a shell string', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => cb(null, { stdout: '', stderr: '' }));

    const { ctx, outputs } = makeCtx({ name: 'my-experiment', experimentName: 'exp-1' });
    await action.handler(ctx);

    expect(mockWriteSecureTempFile).toHaveBeenCalledTimes(1);
    const [prefix, filename] = mockWriteSecureTempFile.mock.calls[0];
    expect(prefix).toBe('training');
    expect(filename).toBe('job-my-experiment.yaml');

    const applyCall = mockExecFile.mock.calls.find(c => c[1][0] === 'apply');
    expect(applyCall).toBeDefined();
    expect(applyCall![1]).toEqual(['apply', '-f', '/tmp/mock-secure-dir/job-my-experiment.yaml']);
    expect(typeof applyCall![1]).not.toBe('string');
    expect(outputs.jobName).toBe('my-experiment-initial-run');
  });

  it('always cleans up the temp directory, even when kubectl apply fails', async () => {
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) => {
      if (args[0] === 'cluster-info') return cb(null, { stdout: '', stderr: '' });
      if (args[0] === 'apply') return cb(new Error('admission webhook denied'));
      return cb(null, { stdout: '', stderr: '' });
    });

    const { ctx } = makeCtx({ name: 'my-experiment', experimentName: 'exp-1' });
    await expect(action.handler(ctx)).rejects.toThrow('admission webhook denied');
    expect(mockCleanupSecureTempDir).toHaveBeenCalledWith('/tmp/mock-secure-dir');
  });

  it('bootstraps the kubeconfig before checking the cluster', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => cb(null, { stdout: '', stderr: '' }));
    const { ctx } = makeCtx({ name: 'my-experiment', experimentName: 'exp-1' });
    await action.handler(ctx);
    expect(mockEnsureKubeconfig).toHaveBeenCalledTimes(1);
  });
});
