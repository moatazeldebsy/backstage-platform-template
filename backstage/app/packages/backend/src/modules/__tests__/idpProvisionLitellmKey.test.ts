import type { ActionContext } from '@backstage/plugin-scaffolder-node';

// Same mocking shape as idpDeployAgent.test.ts — execFile is promisify()'d in
// the module under test, so the mock must follow Node's callback convention.
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

const mockProvisionAwsSecret = jest.fn();
jest.mock('../idpProvisionSecret', () => ({
  provisionAwsSecret: (...args: any[]) => mockProvisionAwsSecret(...args),
}));

import { createProvisionLitellmKeyAction } from '../idpProvisionLitellmKey';

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

function mockFetchJson(handler: (url: string, init: RequestInit) => { status: number; body: unknown } | undefined) {
  global.fetch = jest.fn(async (input: any, init: any) => {
    const result = handler(String(input), init ?? {});
    if (!result) return { ok: false, status: 503, json: async () => ({}) } as any;
    return { ok: result.status < 400, status: result.status, json: async () => result.body } as any;
  }) as any;
}

const ORIGINAL_ENV = process.env;

describe('idp:provision-litellm-key', () => {
  const action = createProvisionLitellmKeyAction();

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...ORIGINAL_ENV, LITELLM_MASTER_KEY: 'sk-master-test' };
    delete process.env.K8S_CLUSTER_URL;
    mockEnsureKubeconfig.mockResolvedValue(undefined);
    mockWriteSecureTempFile.mockImplementation(async (_prefix: string, filename: string) => ({
      dir: '/tmp/mock-secure-dir',
      filePath: `/tmp/mock-secure-dir/${filename}`,
    }));
    mockCleanupSecureTempDir.mockResolvedValue(undefined);
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => cb(null, { stdout: '', stderr: '' }));
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('throws when LITELLM_MASTER_KEY is not set', async () => {
    delete process.env.LITELLM_MASTER_KEY;
    const { ctx } = makeCtx({ serviceName: 'payments-api' });
    await expect(action.handler(ctx)).rejects.toThrow(/LITELLM_MASTER_KEY is not set/);
  });

  it('mints a new key, stores it as a local Secret, and outputs only the opaque token_id', async () => {
    mockFetchJson(url =>
      url.includes('/key/generate')
        ? { status: 200, body: { key: 'sk-raw-secret-value', token_id: 'tok_abc123', key_alias: 'payments-api', max_budget: 50 } }
        : undefined,
    );

    const { ctx, outputs } = makeCtx({ serviceName: 'payments-api' });
    await action.handler(ctx);

    expect(outputs.virtualKeyAnnotationValue).toBe('tok_abc123');
    expect(outputs.budgetUsd).toBe(50);
    expect(String(outputs.secretStorageLocation)).toContain('services-dev/payments-api-litellm-key');

    // The raw key must never appear in an output value.
    expect(Object.values(outputs).some(v => String(v).includes('sk-raw-secret-value'))).toBe(false);

    expect(mockExecFile).toHaveBeenCalledWith(
      'kubectl',
      expect.arrayContaining(['apply', '-f']),
      expect.anything(),
      expect.anything(),
    );
  });

  it('never logs the raw key value', async () => {
    mockFetchJson(() => ({ status: 200, body: { key: 'sk-raw-secret-value', token_id: 'tok_abc123' } }));
    const { ctx } = makeCtx({ serviceName: 'payments-api' });
    await action.handler(ctx);

    const allLogCalls = [
      ...(ctx.logger.info as jest.Mock).mock.calls,
      ...(ctx.logger.warn as jest.Mock).mock.calls,
    ].flat();
    expect(allLogCalls.some(arg => typeof arg === 'string' && arg.includes('sk-raw-secret-value'))).toBe(false);
  });

  it('honours a custom budgetUsd and durationDays in the /key/generate request', async () => {
    let capturedBody: any;
    mockFetchJson((url, init) => {
      if (url.includes('/key/generate')) {
        capturedBody = JSON.parse(String(init.body));
        return { status: 200, body: { key: 'sk-x', token_id: 'tok_x' } };
      }
      return undefined;
    });
    const { ctx } = makeCtx({ serviceName: 'checkout', budgetUsd: 200, durationDays: 90 });
    await action.handler(ctx);
    expect(capturedBody).toMatchObject({ key_alias: 'checkout', max_budget: 200, duration: '90d' });
  });

  it('on a duplicate key_alias (400), looks up the existing key instead of failing', async () => {
    mockFetchJson(url => {
      if (url.includes('/key/generate')) {
        return { status: 400, body: { error: { message: "Key with alias 'checkout' already exists." } } };
      }
      if (url.includes('/key/list')) {
        return { status: 200, body: { keys: ['tok_existing'] } };
      }
      return undefined;
    });

    const { ctx, outputs } = makeCtx({ serviceName: 'checkout' });
    await action.handler(ctx);

    expect(outputs.virtualKeyAnnotationValue).toBe('tok_existing');
    expect(outputs.secretStorageLocation).toBe('(pre-existing — not re-provisioned)');
    // Idempotent: no kubectl/Secret write on the reuse path, since there is no
    // raw key value to store (LiteLLM only returns it once, at creation).
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('throws if a duplicate alias is reported but /key/list finds nothing', async () => {
    mockFetchJson(url => {
      if (url.includes('/key/generate')) return { status: 400, body: { error: { message: 'already exists' } } };
      if (url.includes('/key/list')) return { status: 200, body: { keys: [] } };
      return undefined;
    });
    const { ctx } = makeCtx({ serviceName: 'checkout' });
    await expect(action.handler(ctx)).rejects.toThrow(/already exists but \/key\/list returned none/);
  });

  it('uses AWS Secrets Manager instead of kubectl on AWS (NODE_ENV=production)', async () => {
    // NOT K8S_CLUSTER_URL — that var is set locally too (it only tells
    // ensureKubeconfig() whether to synthesize a kubeconfig), so branching on
    // it here previously misrouted local runs into this AWS-only path and
    // failed with "Could not load credentials from any providers" (confirmed
    // live). NODE_ENV=production is the real signal (aws/backstage/deployment.yaml).
    process.env.NODE_ENV = 'production';
    mockFetchJson(url =>
      url.includes('/key/generate') ? { status: 200, body: { key: 'sk-raw', token_id: 'tok_aws' } } : undefined,
    );
    mockProvisionAwsSecret.mockResolvedValue({ secretArn: 'arn:aws:secretsmanager:us-east-1:123:secret:idp-mvp/services/checkout/LITELLM_VIRTUAL_KEY' });

    const { ctx, outputs } = makeCtx({ serviceName: 'checkout' });
    await action.handler(ctx);

    expect(mockProvisionAwsSecret).toHaveBeenCalledWith(
      expect.objectContaining({ secretPath: 'idp-mvp/services/checkout/LITELLM_VIRTUAL_KEY', secretValue: 'sk-raw' }),
    );
    expect(outputs.secretStorageLocation).toContain('arn:aws:secretsmanager');
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('throws with the raw LiteLLM error body on an unexpected /key/generate failure', async () => {
    mockFetchJson(() => ({ status: 500, body: { error: 'internal' } }));
    const { ctx } = makeCtx({ serviceName: 'checkout' });
    await expect(action.handler(ctx)).rejects.toThrow(/LiteLLM \/key\/generate failed \(HTTP 500\)/);
  });
});
