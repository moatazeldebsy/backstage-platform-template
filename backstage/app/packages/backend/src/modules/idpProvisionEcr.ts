import { createBackendModule } from '@backstage/backend-plugin-api';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import {
  ECRClient,
  CreateRepositoryCommand,
  PutLifecyclePolicyCommand,
  RepositoryAlreadyExistsException,
} from '@aws-sdk/client-ecr';

function createProvisionEcrAction() {
  return createTemplateAction({
    id: 'idp:provision-ecr',
    description:
      'Create (or reuse) an ECR repository for a service with image scanning and a 90-day untagged-image lifecycle policy.',
    schema: {
      input: {
        serviceName: z => z.string().describe('Name of the owning service (e.g. payments-api)'),
        clusterName: z =>
          z
            .string()
            .describe('Cluster/prefix the repository is namespaced under (matches the ECR repo naming used by CI: "<clusterName>/<serviceName>")'),
        awsRegion: z => z.string().optional().describe('AWS region (default: us-east-1)'),
      },
      output: {
        repositoryUri: z => z.string().describe('ECR repository URI'),
        repositoryArn: z => z.string().describe('ECR repository ARN'),
      },
    },

    async handler(ctx) {
      const { serviceName, clusterName, awsRegion = 'us-east-1' } = ctx.input;

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
          ctx.logger.info(`ECR repository ${repositoryName} already exists — reusing it.`);
          repositoryUri = `${repositoryName}`;
          repositoryArn = '';
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

      ctx.output('repositoryUri', repositoryUri);
      ctx.output('repositoryArn', repositoryArn);
    },
  });
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
