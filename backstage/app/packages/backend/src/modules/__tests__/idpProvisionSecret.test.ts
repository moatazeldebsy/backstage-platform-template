import type { ActionContext } from '@backstage/plugin-scaffolder-node';

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-secrets-manager', () => {
  class MockResourceExistsException extends Error {
    name = 'ResourceExistsException';
  }
  return {
    SecretsManagerClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
    CreateSecretCommand: jest.fn().mockImplementation((input: any) => ({ __type: 'Create', input })),
    PutSecretValueCommand: jest.fn().mockImplementation((input: any) => ({ __type: 'Put', input })),
    GetSecretValueCommand: jest.fn().mockImplementation((input: any) => ({ __type: 'Get', input })),
    ResourceExistsException: MockResourceExistsException,
  };
});

const { ResourceExistsException: FakeResourceExistsException } = jest.requireMock(
  '@aws-sdk/client-secrets-manager',
) as { ResourceExistsException: new (msg: string) => Error };

import { createProvisionSecretAction } from '../idpProvisionSecret';

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

describe('idp:provision-secret', () => {
  const action = createProvisionSecretAction();

  beforeEach(() => {
    mockSend.mockReset();
  });

  it('creates a brand new secret and returns its ARN', async () => {
    mockSend.mockResolvedValueOnce({ ARN: 'arn:aws:secretsmanager:us-east-1:123:secret:idp-mvp/services/payments-api/STRIPE_API_KEY' });

    const { ctx, outputs } = makeCtx({
      serviceName: 'payments-api',
      secretKey: 'STRIPE_API_KEY',
      secretValue: 'sk_live_super_secret',
    });
    await action.handler(ctx);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const [command] = mockSend.mock.calls[0];
    expect(command.__type).toBe('Create');
    expect(command.input.Name).toBe('idp-mvp/services/payments-api/STRIPE_API_KEY');
    expect(command.input.SecretString).toBe('sk_live_super_secret');

    expect(outputs.secretArn).toContain('STRIPE_API_KEY');
    expect(outputs.secretPath).toBe('idp-mvp/services/payments-api/STRIPE_API_KEY');
  });

  it('never logs the secret value itself', async () => {
    mockSend.mockResolvedValueOnce({ ARN: 'arn:aws:secretsmanager:...' });
    const { ctx } = makeCtx({
      serviceName: 'payments-api',
      secretKey: 'STRIPE_API_KEY',
      secretValue: 'sk_live_super_secret',
    });
    await action.handler(ctx);

    const allLogCalls = [
      ...(ctx.logger.info as jest.Mock).mock.calls,
      ...(ctx.logger.warn as jest.Mock).mock.calls,
    ].flat();
    expect(allLogCalls.some(arg => typeof arg === 'string' && arg.includes('sk_live_super_secret'))).toBe(false);
  });

  it('defaults region to us-east-1 and path prefix to idp-mvp/services', async () => {
    mockSend.mockResolvedValueOnce({ ARN: 'arn:...' });
    const { ctx, outputs } = makeCtx({
      serviceName: 'checkout',
      secretKey: 'API_KEY',
      secretValue: 'x',
    });
    await action.handler(ctx);
    expect(outputs.secretPath).toBe('idp-mvp/services/checkout/API_KEY');
  });

  it('honours a custom awsRegion and secretPathPrefix', async () => {
    mockSend.mockResolvedValueOnce({ ARN: 'arn:...' });
    const { ctx, outputs } = makeCtx({
      serviceName: 'checkout',
      secretKey: 'API_KEY',
      secretValue: 'x',
      awsRegion: 'eu-west-1',
      secretPathPrefix: 'custom/prefix',
    });
    await action.handler(ctx);
    expect(outputs.secretPath).toBe('custom/prefix/checkout/API_KEY');
  });

  it('falls back to update-in-place when the secret already exists', async () => {
    mockSend
      .mockRejectedValueOnce(new FakeResourceExistsException('already exists'))
      .mockResolvedValueOnce({ ARN: 'arn:aws:secretsmanager:us-east-1:123:secret:existing' }) // GetSecretValueCommand
      .mockResolvedValueOnce({}); // PutSecretValueCommand

    const { ctx, outputs } = makeCtx({
      serviceName: 'payments-api',
      secretKey: 'STRIPE_API_KEY',
      secretValue: 'new-value',
    });
    await action.handler(ctx);

    expect(mockSend).toHaveBeenCalledTimes(3);
    expect(mockSend.mock.calls[1][0].__type).toBe('Get');
    expect(mockSend.mock.calls[2][0].__type).toBe('Put');
    expect(mockSend.mock.calls[2][0].input.SecretString).toBe('new-value');
    expect(outputs.secretArn).toBe('arn:aws:secretsmanager:us-east-1:123:secret:existing');
  });

  it('wraps any other AWS error with context rather than leaking the raw SDK error', async () => {
    mockSend.mockRejectedValueOnce(new Error('AccessDenied: user is not authorized'));

    const { ctx } = makeCtx({
      serviceName: 'payments-api',
      secretKey: 'STRIPE_API_KEY',
      secretValue: 'x',
    });
    await expect(action.handler(ctx)).rejects.toThrow(
      /Failed to provision secret at idp-mvp\/services\/payments-api\/STRIPE_API_KEY/,
    );
  });

  it('builds an ExternalSecret manifest with a Kubernetes-safe name (underscores → hyphens, lowercased)', async () => {
    mockSend.mockResolvedValueOnce({ ARN: 'arn:...' });
    const { ctx, outputs } = makeCtx({
      serviceName: 'payments-api',
      secretKey: 'STRIPE_API_KEY',
      secretValue: 'x',
    });
    await action.handler(ctx);

    const yaml = outputs.externalSecretYaml as string;
    expect(yaml).toContain('name: payments-api-stripe-api-key');
    expect(yaml).toContain('namespace: services');
    expect(yaml).toContain('key: idp-mvp/services/payments-api/STRIPE_API_KEY');
    expect(yaml).toContain('secretKey: STRIPE_API_KEY'); // the env var name itself keeps its original casing
  });
});
