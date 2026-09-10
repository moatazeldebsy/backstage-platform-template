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

import { createDeployModelServerAction } from '../idpDeployModelServer';

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

/**
 * Every execFile call succeeds by default; override with .mockImplementation
 * per test. `get nodes -l accelerator` (the vLLM GPU-node check) returns a
 * node by default so tests not specifically exercising that guard don't trip
 * it incidentally.
 */
function succeedAllExecFile() {
  mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) => {
    if (args[0] === 'get') return cb(null, { stdout: 'node/gpu-node-1\n', stderr: '' });
    return cb(null, { stdout: '', stderr: '' });
  });
}

function mockMlflowFetch(ok = true, status = 200) {
  global.fetch = jest.fn().mockResolvedValue({
    ok,
    status,
    text: async () => 'ignored',
  }) as unknown as typeof fetch;
}

describe('idp:deploy-model-server', () => {
  const action = createDeployModelServerAction();
  const originalAllowOllama = process.env.IDP_ALLOW_LOCAL_OLLAMA;

  beforeEach(() => {
    mockExecFile.mockReset();
    mockEnsureKubeconfig.mockReset().mockResolvedValue(undefined);
    mockWriteSecureTempFile.mockReset().mockImplementation(async (_prefix: string, filename: string, contents: string) => ({
      dir: '/tmp/mock-secure-dir',
      filePath: `/tmp/mock-secure-dir/${filename}`,
      __contents: contents,
    }));
    mockCleanupSecureTempDir.mockReset().mockResolvedValue(undefined);
    mockMlflowFetch(true, 200);
    delete process.env.IDP_ALLOW_LOCAL_OLLAMA;
  });

  afterAll(() => {
    if (originalAllowOllama === undefined) delete process.env.IDP_ALLOW_LOCAL_OLLAMA;
    else process.env.IDP_ALLOW_LOCAL_OLLAMA = originalAllowOllama;
  });

  it('rejects an invalid k8s name before touching the cluster', async () => {
    const { ctx } = makeCtx({ name: 'Bad_Name!', modelName: 'llama3', target: 'local' });
    await expect(action.handler(ctx)).rejects.toThrow(/Invalid name/);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('rejects an invalid model name', async () => {
    const { ctx } = makeCtx({ name: 'my-model', modelName: 'Not Valid!', target: 'local' });
    await expect(action.handler(ctx)).rejects.toThrow(/Invalid modelName/);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('rejects a target other than local/aws', async () => {
    const { ctx } = makeCtx({ name: 'my-model', modelName: 'llama3', target: 'staging' });
    await expect(action.handler(ctx)).rejects.toThrow(/Invalid target/);
  });

  it('only bootstraps the kubeconfig for target=aws, not target=local', async () => {
    succeedAllExecFile();
    const { ctx: localCtx } = makeCtx({ name: 'my-model', modelName: 'llama3', target: 'local' });
    await action.handler(localCtx);
    expect(mockEnsureKubeconfig).not.toHaveBeenCalled();

    mockExecFile.mockReset();
    succeedAllExecFile();
    const { ctx: awsCtx } = makeCtx({ name: 'my-model', modelName: 'llama3', target: 'aws' });
    await action.handler(awsCtx);
    expect(mockEnsureKubeconfig).toHaveBeenCalledTimes(1);
  });

  it('wraps a cluster-unreachable failure with a clear message', async () => {
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) => {
      if (args[0] === 'cluster-info') cb(new Error('connection refused'));
      else cb(null, { stdout: '', stderr: '' });
    });
    const { ctx } = makeCtx({ name: 'my-model', modelName: 'llama3', target: 'local' });
    await expect(action.handler(ctx)).rejects.toThrow('Cannot reach the cluster: connection refused');
    expect(mockWriteSecureTempFile).not.toHaveBeenCalled();
  });

  it('refuses real Ollama on local without the explicit override', async () => {
    succeedAllExecFile();
    const { ctx } = makeCtx({ name: 'my-model', modelName: 'llama3', target: 'local', serverType: 'ollama' });
    await expect(action.handler(ctx)).rejects.toThrow(/IDP_ALLOW_LOCAL_OLLAMA=true/);
    expect(mockWriteSecureTempFile).not.toHaveBeenCalled();
  });

  it('allows real Ollama on local when IDP_ALLOW_LOCAL_OLLAMA=true', async () => {
    process.env.IDP_ALLOW_LOCAL_OLLAMA = 'true';
    succeedAllExecFile();
    const { ctx } = makeCtx({ name: 'my-model', modelName: 'llama3', target: 'local', serverType: 'ollama' });
    await action.handler(ctx);
    const yaml = mockWriteSecureTempFile.mock.calls[0][2] as string;
    expect(yaml).toContain('ollama/ollama');
  });

  it('refuses vLLM when no GPU node is found', async () => {
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) => {
      if (args[0] === 'get') return cb(null, { stdout: '', stderr: '' }); // no nodes returned
      return cb(null, { stdout: '', stderr: '' });
    });
    const { ctx } = makeCtx({ name: 'my-model', modelName: 'llama3', target: 'aws', serverType: 'vllm' });
    await expect(action.handler(ctx)).rejects.toThrow(/No GPU node found/);
    expect(mockWriteSecureTempFile).not.toHaveBeenCalled();
  });

  it('deploys vLLM when a GPU node is present', async () => {
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) => {
      if (args[0] === 'get') return cb(null, { stdout: 'node/gpu-node-1\n', stderr: '' });
      return cb(null, { stdout: '', stderr: '' });
    });
    const { ctx, outputs } = makeCtx({ name: 'my-model', modelName: 'llama3', target: 'aws', serverType: 'vllm' });
    await action.handler(ctx);
    const yaml = mockWriteSecureTempFile.mock.calls[0][2] as string;
    expect(yaml).toContain('vllm/vllm-openai');
    expect(outputs.deploymentName).toBe('my-model-vllm');
  });

  it('defaults to mock on local and vllm on aws when serverType is omitted', async () => {
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) => {
      if (args[0] === 'get') return cb(null, { stdout: 'node/gpu-node-1\n', stderr: '' });
      return cb(null, { stdout: '', stderr: '' });
    });

    const { ctx: localCtx } = makeCtx({ name: 'my-model', modelName: 'llama3', target: 'local' });
    await action.handler(localCtx);
    expect(mockWriteSecureTempFile.mock.calls[0][2]).toContain('kind: ConfigMap');

    mockWriteSecureTempFile.mockClear();
    const { ctx: awsCtx } = makeCtx({ name: 'my-model', modelName: 'llama3', target: 'aws' });
    await action.handler(awsCtx);
    expect(mockWriteSecureTempFile.mock.calls[0][2]).toContain('vllm/vllm-openai');
  });

  it('applies the manifest via execFile with an args array and cleans up the temp dir', async () => {
    succeedAllExecFile();
    const { ctx } = makeCtx({ name: 'my-model', modelName: 'llama3', target: 'local' });
    await action.handler(ctx);
    const applyCall = mockExecFile.mock.calls.find(c => c[1][0] === 'apply');
    expect(applyCall![1]).toEqual(['apply', '-f', '/tmp/mock-secure-dir/my-model.yaml']);
    expect(mockCleanupSecureTempDir).toHaveBeenCalledWith('/tmp/mock-secure-dir');
  });

  it('does not fail the action when the rollout wait times out — logged as non-fatal', async () => {
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) => {
      if (args[0] === 'rollout') return cb(new Error('timed out waiting for rollout'));
      return cb(null, { stdout: '', stderr: '' });
    });
    const { ctx } = makeCtx({ name: 'my-model', modelName: 'llama3', target: 'local' });
    await expect(action.handler(ctx)).resolves.toBeUndefined();
    expect((ctx.logger.warn as jest.Mock).mock.calls.some(c => String(c[0]).includes('may still be rolling out'))).toBe(true);
  });

  it('treats an MLflow 409 (already registered) as success', async () => {
    succeedAllExecFile();
    mockMlflowFetch(false, 409);
    const { ctx } = makeCtx({ name: 'my-model', modelName: 'llama3', target: 'local' });
    await action.handler(ctx);
    expect((ctx.logger.info as jest.Mock).mock.calls.some(c => String(c[0]).includes('registered in MLflow'))).toBe(true);
  });

  it('does not fail the action when the MLflow registration call throws — non-fatal', async () => {
    succeedAllExecFile();
    global.fetch = jest.fn().mockRejectedValue(new Error('mlflow unreachable')) as unknown as typeof fetch;
    const { ctx } = makeCtx({ name: 'my-model', modelName: 'llama3', target: 'local' });
    await expect(action.handler(ctx)).resolves.toBeUndefined();
    expect((ctx.logger.warn as jest.Mock).mock.calls.some(c => String(c[0]).includes('Could not register model in MLflow'))).toBe(true);
  });

  it('reports a local http URL for target=local and an https URL for target=aws', async () => {
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) => {
      if (args[0] === 'get') return cb(null, { stdout: 'node/gpu-node-1\n', stderr: '' });
      return cb(null, { stdout: '', stderr: '' });
    });

    const { ctx: localCtx, outputs: localOutputs } = makeCtx({ name: 'my-model', modelName: 'llama3', target: 'local' });
    await action.handler(localCtx);
    expect(localOutputs.serverUrl).toBe('http://my-model.idp.local');

    const { ctx: awsCtx, outputs: awsOutputs } = makeCtx({ name: 'my-model', modelName: 'llama3', target: 'aws' });
    await action.handler(awsCtx);
    expect(awsOutputs.serverUrl).toBe('https://my-model.prod.company.com');
  });
});
