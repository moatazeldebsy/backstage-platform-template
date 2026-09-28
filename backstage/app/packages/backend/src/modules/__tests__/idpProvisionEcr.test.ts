import type { ActionContext } from '@backstage/plugin-scaffolder-node';

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-ecr', () => {
  class MockRepositoryAlreadyExistsException extends Error {
    name = 'RepositoryAlreadyExistsException';
  }
  return {
    ECRClient: jest.fn().mockImplementation((opts: any) => ({ send: mockSend, __opts: opts })),
    CreateRepositoryCommand: jest.fn().mockImplementation((input: any) => ({ __type: 'Create', input })),
    DescribeRepositoriesCommand: jest.fn().mockImplementation((input: any) => ({ __type: 'Describe', input })),
    PutLifecyclePolicyCommand: jest.fn().mockImplementation((input: any) => ({ __type: 'PutLifecycle', input })),
    RepositoryAlreadyExistsException: MockRepositoryAlreadyExistsException,
  };
});

const mockIamSend = jest.fn();

jest.mock('@aws-sdk/client-iam', () => {
  class MockEntityAlreadyExistsException extends Error {
    name = 'EntityAlreadyExistsException';
  }
  return {
    IAMClient: jest.fn().mockImplementation(() => ({ send: mockIamSend })),
    CreateRoleCommand: jest.fn().mockImplementation((input: any) => ({ __type: 'CreateRole', input })),
    UpdateAssumeRolePolicyCommand: jest.fn().mockImplementation((input: any) => ({ __type: 'UpdateTrust', input })),
    PutRolePolicyCommand: jest.fn().mockImplementation((input: any) => ({ __type: 'PutRolePolicy', input })),
    EntityAlreadyExistsException: MockEntityAlreadyExistsException,
  };
});

const { EntityAlreadyExistsException: FakeRoleExistsException } = jest.requireMock('@aws-sdk/client-iam') as {
  EntityAlreadyExistsException: new (msg: string) => Error;
};

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
    mockIamSend.mockReset();
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

  it('reuses an existing repository and reports its real URI, not the bare name', async () => {
    // The URI becomes the image repository in helm-values-aws.yaml; the bare
    // "kind/payments-api" it used to return has no registry host and cannot be pulled.
    mockSend
      .mockRejectedValueOnce(new FakeRepoExistsException('already exists'))
      .mockResolvedValueOnce({ repositories: [{ repositoryUri: '123.dkr.ecr.us-east-1.amazonaws.com/kind/payments-api', repositoryArn: 'arn:aws:ecr:us-east-1:123:repository/kind/payments-api' }] })
      .mockResolvedValueOnce({});

    const { ctx, outputs } = makeCtx({ serviceName: 'payments-api', clusterName: 'kind' });
    await action.handler(ctx);

    expect(mockSend.mock.calls[1][0]).toMatchObject({ __type: 'Describe', input: { repositoryNames: ['kind/payments-api'] } });
    expect(outputs.repositoryUri).toBe('123.dkr.ecr.us-east-1.amazonaws.com/kind/payments-api');
    expect(outputs.repositoryArn).toBe('arn:aws:ecr:us-east-1:123:repository/kind/payments-api');
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

  describe('image-push role', () => {
    const repoArn = 'arn:aws:ecr:us-east-1:123456789012:repository/idp-mvp/payments-api';
    const created = () =>
      mockSend
        .mockResolvedValueOnce({ repository: { repositoryUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/idp-mvp/payments-api', repositoryArn: repoArn } })
        .mockResolvedValueOnce({});
    const input = { serviceName: 'payments-api', clusterName: 'idp-mvp', githubOwner: 'acme', githubRepo: 'payments-api' };

    it('creates a role only that repo\'s main branch can assume, bounded and push-only', async () => {
      created();
      mockIamSend
        .mockResolvedValueOnce({ Role: { Arn: 'arn:aws:iam::123456789012:role/idp-mvp-svc-push-payments-api' } })
        .mockResolvedValueOnce({});
      const { ctx, outputs } = makeCtx(input);
      await action.handler(ctx);

      const create = mockIamSend.mock.calls[0][0];
      expect(create.__type).toBe('CreateRole');
      expect(create.input.RoleName).toBe('idp-mvp-svc-push-payments-api');
      // Terraform only allows Backstage to create roles carrying this boundary.
      expect(create.input.PermissionsBoundary).toBe('arn:aws:iam::123456789012:policy/idp-mvp-service-image-push-boundary');
      const trust = JSON.parse(create.input.AssumeRolePolicyDocument).Statement[0];
      expect(trust.Principal.Federated).toBe('arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com');
      expect(trust.Condition.StringEquals['token.actions.githubusercontent.com:sub']).toBe('repo:acme/payments-api:ref:refs/heads/main');

      const policy = JSON.parse(mockIamSend.mock.calls[1][0].input.PolicyDocument);
      expect(policy.Statement[1].Resource).toBe(repoArn);
      expect(policy.Statement[1].Action).toContain('ecr:PutImage');
      expect(JSON.stringify(policy)).not.toContain('ecr:Delete');

      expect(outputs.pushRoleArn).toBe('arn:aws:iam::123456789012:role/idp-mvp-svc-push-payments-api');
    });

    it('re-points an existing role at the repo instead of failing', async () => {
      created();
      mockIamSend
        .mockRejectedValueOnce(new FakeRoleExistsException('exists'))
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});
      const { ctx, outputs } = makeCtx(input);
      await action.handler(ctx);

      expect(mockIamSend.mock.calls.map(c => c[0].__type)).toEqual(['CreateRole', 'UpdateTrust', 'PutRolePolicy']);
      expect(outputs.pushRoleArn).toBe('arn:aws:iam::123456789012:role/idp-mvp-svc-push-payments-api');
    });

    it('creates no role without the service repository', async () => {
      created();
      const { ctx, outputs } = makeCtx({ serviceName: 'payments-api', clusterName: 'idp-mvp' });
      await action.handler(ctx);
      expect(mockIamSend).not.toHaveBeenCalled();
      expect(outputs.pushRoleArn).toBe('');
    });
  });
});
