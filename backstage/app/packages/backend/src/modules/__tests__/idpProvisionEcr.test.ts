import type { ActionContext } from '@backstage/plugin-scaffolder-node';

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-ecr', () => {
  class MockRepositoryAlreadyExistsException extends Error {
    name = 'RepositoryAlreadyExistsException';
  }
  return {
    ECRClient: jest.fn().mockImplementation((opts: any) => ({ send: mockSend, __opts: opts })),
    CreateRepositoryCommand: jest.fn().mockImplementation((input: any) => ({ __type: 'Create', input })),
    PutLifecyclePolicyCommand: jest.fn().mockImplementation((input: any) => ({ __type: 'PutLifecycle', input })),
    RepositoryAlreadyExistsException: MockRepositoryAlreadyExistsException,
  };
});

const { ECRClient: MockECRClient, RepositoryAlreadyExistsException: FakeRepoExistsException } = jest.requireMock(
  '@aws-sdk/client-ecr',
) as { ECRClient: jest.Mock; RepositoryAlreadyExistsException: new (msg: string) => Error };

import { createProvisionEcrAction } from '../idpProvisionEcr';

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

describe('idp:provision-ecr', () => {
  const action = createProvisionEcrAction();

  beforeEach(() => {
    mockSend.mockReset();
    MockECRClient.mockClear();
  });

  it('creates the repository and reports its URI and ARN', async () => {
    mockSend
      .mockResolvedValueOnce({ repository: { repositoryUri: '123.dkr.ecr.us-east-1.amazonaws.com/kind/payments-api', repositoryArn: 'arn:aws:ecr:...:repository/kind/payments-api' } })
      .mockResolvedValueOnce({}); // PutLifecyclePolicy

    const { ctx, outputs } = makeCtx({ serviceName: 'payments-api', clusterName: 'kind' });
    await action.handler(ctx);

    expect(outputs.repositoryUri).toBe('123.dkr.ecr.us-east-1.amazonaws.com/kind/payments-api');
    expect(outputs.repositoryArn).toBe('arn:aws:ecr:...:repository/kind/payments-api');

    const createCall = mockSend.mock.calls[0][0];
    expect(createCall.input.repositoryName).toBe('kind/payments-api');
    expect(createCall.input.imageScanningConfiguration).toEqual({ scanOnPush: true });
  });

  it('reuses an existing repository instead of failing when it already exists', async () => {
    mockSend
      .mockRejectedValueOnce(new FakeRepoExistsException('already exists'))
      .mockResolvedValueOnce({});

    const { ctx, outputs } = makeCtx({ serviceName: 'payments-api', clusterName: 'kind' });
    await action.handler(ctx);

    expect(outputs.repositoryUri).toBe('kind/payments-api');
    expect(outputs.repositoryArn).toBe('');
    expect((ctx.logger.info as jest.Mock).mock.calls.some(c => String(c[0]).includes('already exists'))).toBe(true);
  });

  it('wraps any other creation failure with a clear message', async () => {
    mockSend.mockRejectedValueOnce(new Error('access denied'));
    const { ctx } = makeCtx({ serviceName: 'payments-api', clusterName: 'kind' });
    await expect(action.handler(ctx)).rejects.toThrow(
      'Failed to provision ECR repository kind/payments-api: access denied',
    );
  });

  it('applies a 90-day untagged-image expiry lifecycle policy', async () => {
    mockSend.mockResolvedValue({ repository: {} });
    const { ctx } = makeCtx({ serviceName: 'payments-api', clusterName: 'kind' });
    await action.handler(ctx);

    const lifecycleCall = mockSend.mock.calls.find(c => c[0].__type === 'PutLifecycle');
    expect(lifecycleCall).toBeDefined();
    const policy = JSON.parse(lifecycleCall![0].input.lifecyclePolicyText);
    expect(policy.rules[0]).toMatchObject({
      selection: { tagStatus: 'untagged', countType: 'sinceImagePushed', countUnit: 'days', countNumber: 90 },
      action: { type: 'expire' },
    });
  });

  it('defaults to us-east-1 when no awsRegion is given, and honours an explicit one', async () => {
    mockSend.mockResolvedValue({ repository: {} });

    await action.handler(makeCtx({ serviceName: 'payments-api', clusterName: 'kind' }).ctx);
    expect(MockECRClient.mock.calls[0][0]).toEqual({ region: 'us-east-1' });

    MockECRClient.mockClear();
    await action.handler(makeCtx({ serviceName: 'payments-api', clusterName: 'kind', awsRegion: 'eu-west-1' }).ctx);
    expect(MockECRClient.mock.calls[0][0]).toEqual({ region: 'eu-west-1' });
  });
});
