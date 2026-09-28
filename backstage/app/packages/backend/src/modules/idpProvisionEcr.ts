import { createBackendModule } from '@backstage/backend-plugin-api';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import {
  ECRClient,
  CreateRepositoryCommand,
  DescribeRepositoriesCommand,
  PutLifecyclePolicyCommand,
  RepositoryAlreadyExistsException,
} from '@aws-sdk/client-ecr';
import {
  IAMClient,
  CreateRoleCommand,
  UpdateAssumeRolePolicyCommand,
  PutRolePolicyCommand,
  EntityAlreadyExistsException,
} from '@aws-sdk/client-iam';

const GITHUB_OIDC_HOST = 'token.actions.githubusercontent.com';

/** Name of the per-service push role; IAM caps role names at 64 characters. */
export function pushRoleName(clusterName: string, serviceName: string): string {
  return `${clusterName}-svc-push-${serviceName}`.slice(0, 64);
}

/**
 * Trust policy for a service's image-push role: only GitHub Actions runs on the
 * main branch of that one repository can assume it. The platform's own
 * github-actions role deliberately trusts only the platform repo (it is
 * near-admin), so service repos need their own, narrow role.
 */
export function pushRoleTrustPolicy(accountId: string, owner: string, repo: string): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { Federated: `arn:aws:iam::${accountId}:oidc-provider/${GITHUB_OIDC_HOST}` },
        Action: 'sts:AssumeRoleWithWebIdentity',
        Condition: {
          StringEquals: {
            [`${GITHUB_OIDC_HOST}:aud`]: 'sts.amazonaws.com',
            [`${GITHUB_OIDC_HOST}:sub`]: `repo:${owner}/${repo}:ref:refs/heads/main`,
          },
        },
      },
    ],
  });
}

/** Permissions of the push role: push to its own ECR repository, nothing else. */
export function pushRolePolicy(repositoryArn: string): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      { Effect: 'Allow', Action: 'ecr:GetAuthorizationToken', Resource: '*' },
      {
        Effect: 'Allow',
        Action: [
          'ecr:BatchCheckLayerAvailability',
          'ecr:BatchGetImage',
          'ecr:CompleteLayerUpload',
          'ecr:InitiateLayerUpload',
          'ecr:PutImage',
          'ecr:UploadLayerPart',
        ],
        Resource: repositoryArn,
      },
    ],
  });
}

export function createProvisionEcrAction() {
  return createTemplateAction({
    id: 'idp:provision-ecr',
    description:
      'Create (or reuse) an ECR repository for a service with image scanning and a 90-day untagged-image lifecycle policy, and — given the service repository — an IAM role its CI can assume to push there.',
    schema: {
      input: {
        serviceName: z => z.string().describe('Name of the owning service (e.g. payments-api)'),
        clusterName: z =>
          z
            .string()
            .describe('Cluster/prefix the repository is namespaced under (matches the ECR repo naming used by CI: "<clusterName>/<serviceName>")'),
        awsRegion: z => z.string().optional().describe('AWS region (default: us-east-1)'),
        githubOwner: z =>
          z.string().optional().describe('Owner of the service repository; with githubRepo, creates its push role'),
        githubRepo: z =>
          z.string().optional().describe('Name of the service repository whose main-branch CI may push images'),
      },
      output: {
        repositoryUri: z => z.string().describe('ECR repository URI'),
        repositoryArn: z => z.string().describe('ECR repository ARN'),
        pushRoleArn: z =>
          z.string().describe('IAM role the service repository assumes to push to the repository (empty without githubOwner/githubRepo)'),
      },
    },

    async handler(ctx) {
      const { serviceName, clusterName, awsRegion = 'us-east-1', githubOwner, githubRepo } = ctx.input;

      const repositoryName = `${clusterName}/${serviceName}`;
      ctx.logger.info(`Provisioning ECR repository ${repositoryName} in ${awsRegion}...`);

      const client = new ECRClient({ region: awsRegion });

      let repositoryUri: string;
      let repositoryArn: string;

      try {
        const createCmd = new CreateRepositoryCommand({
          repositoryName,
          imageScanningConfiguration: { scanOnPush: true },
          tags: [
            { Key: 'managed-by', Value: 'idp-backstage' },
            { Key: 'service', Value: serviceName },
          ],
        });
        const result = await client.send(createCmd);
        repositoryUri = result.repository?.repositoryUri ?? repositoryName;
        repositoryArn = result.repository?.repositoryArn ?? '';
        ctx.logger.info(`ECR repository created: ${repositoryUri}`);
      } catch (err: any) {
        if (err instanceof RepositoryAlreadyExistsException || err.name === 'RepositoryAlreadyExistsException') {
          // Look the repository up rather than returning its bare name: the URI
          // is written into helm-values-aws.yaml as the image repository, and
          // "<cluster>/<service>" without the registry host is not pullable.
          const described = await client.send(new DescribeRepositoriesCommand({ repositoryNames: [repositoryName] }));
          const repo = described.repositories?.[0];
          repositoryUri = repo?.repositoryUri ?? repositoryName;
          repositoryArn = repo?.repositoryArn ?? '';
          ctx.logger.info(`ECR repository ${repositoryName} already exists — reusing ${repositoryUri}.`);
        } else {
          throw new Error(`Failed to provision ECR repository ${repositoryName}: ${err.message}`);
        }
      }

      // 90-day expiry lifecycle policy for untagged images (mirrors terraform/ecr.tf's
      // Terraform-managed repos, so self-service repos get the same retention behavior).
      const lifecyclePolicy = JSON.stringify({
        rules: [
          {
            rulePriority: 1,
            description: 'Expire untagged images older than 90 days',
            selection: {
              tagStatus: 'untagged',
              countType: 'sinceImagePushed',
              countUnit: 'days',
              countNumber: 90,
            },
            action: { type: 'expire' },
          },
        ],
      });

      await client.send(
        new PutLifecyclePolicyCommand({
          repositoryName,
          lifecyclePolicyText: lifecyclePolicy,
        }),
      );
      ctx.logger.info(`Lifecycle policy applied to ${repositoryName}.`);

      let pushRoleArn = '';
      if (githubOwner && githubRepo) {
        pushRoleArn = await ensurePushRole(ctx, {
          clusterName,
          serviceName,
          repositoryArn,
          owner: githubOwner,
          repo: githubRepo,
        });
      }

      ctx.output('repositoryUri', repositoryUri);
      ctx.output('repositoryArn', repositoryArn);
      ctx.output('pushRoleArn', pushRoleArn);
    },
  });
}

/**
 * Create — or, when it exists, re-point — the role the service repository's
 * CI assumes to push images. Terraform only lets Backstage create roles named
 * <cluster>-svc-push-* that carry the <cluster>-service-image-push-boundary
 * permissions boundary, so whatever is written here can never exceed an image
 * push to <cluster>/* repositories.
 */
async function ensurePushRole(
  ctx: { logger: { info(msg: string): void } },
  opts: { clusterName: string; serviceName: string; repositoryArn: string; owner: string; repo: string },
): Promise<string> {
  const { clusterName, serviceName, repositoryArn, owner, repo } = opts;
  // arn:aws:ecr:<region>:<account>:repository/<name>
  const accountId = repositoryArn.split(':')[4];
  if (!accountId) {
    throw new Error(`Cannot create the image-push role: no account id in ECR repository ARN "${repositoryArn}"`);
  }
  const roleName = pushRoleName(clusterName, serviceName);
  const boundaryArn = `arn:aws:iam::${accountId}:policy/${clusterName}-service-image-push-boundary`;
  const trust = pushRoleTrustPolicy(accountId, owner, repo);
  const iam = new IAMClient({});

  let roleArn: string;
  try {
    const created = await iam.send(
      new CreateRoleCommand({
        RoleName: roleName,
        AssumeRolePolicyDocument: trust,
        PermissionsBoundary: boundaryArn,
        Description: `CI image push for ${owner}/${repo} to ${clusterName}/${serviceName} (scaffolded by Backstage)`,
        Tags: [
          { Key: 'managed-by', Value: 'idp-backstage' },
          { Key: 'service', Value: serviceName },
        ],
      }),
    );
    roleArn = created.Role?.Arn ?? `arn:aws:iam::${accountId}:role/${roleName}`;
    ctx.logger.info(`Image-push role created: ${roleArn}`);
  } catch (err: any) {
    if (!(err instanceof EntityAlreadyExistsException || err.name === 'EntityAlreadyExistsException')) {
      throw new Error(`Failed to create image-push role ${roleName}: ${err.message}`);
    }
    await iam.send(new UpdateAssumeRolePolicyCommand({ RoleName: roleName, PolicyDocument: trust }));
    roleArn = `arn:aws:iam::${accountId}:role/${roleName}`;
    ctx.logger.info(`Image-push role ${roleName} already exists — now trusts ${owner}/${repo}.`);
  }

  await iam.send(
    new PutRolePolicyCommand({
      RoleName: roleName,
      PolicyName: 'ecr-push',
      PolicyDocument: pushRolePolicy(repositoryArn),
    }),
  );
  return roleArn;
}

export const idpProvisionEcrModule = createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'idp-provision-ecr',
  register(env) {
    env.registerInit({
      deps: {
        scaffolder: scaffolderActionsExtensionPoint,
      },
      async init({ scaffolder }) {
        scaffolder.addActions(createProvisionEcrAction());
      },
    });
  },
});
