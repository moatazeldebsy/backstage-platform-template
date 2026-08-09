import { createBackendModule } from '@backstage/backend-plugin-api';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import {
  SecretsManagerClient,
  CreateSecretCommand,
  PutSecretValueCommand,
  GetSecretValueCommand,
  ResourceExistsException,
} from '@aws-sdk/client-secrets-manager';

function createProvisionSecretAction() {
  return createTemplateAction({
    id: 'idp:provision-secret',
    description:
      'Create (or update) an AWS Secrets Manager secret for a service and return an ExternalSecret manifest.',
    schema: {
      input: {
        serviceName: z => z.string().describe('Name of the owning service (e.g. payments-api)'),
        secretKey: z =>
          z.string().describe('Environment variable name the secret will be injected as (e.g. STRIPE_API_KEY)'),
        secretValue: z => z.string().describe('The sensitive value to store — never logged'),
        awsRegion: z => z.string().optional().describe('AWS region (default: us-east-1)'),
        secretPathPrefix: z =>
          z.string().optional().describe('AWS Secrets Manager path prefix (default: idp-mvp/services)'),
      },
      output: {
        secretArn: z => z.string().describe('AWS secret ARN'),
        secretPath: z => z.string().describe('AWS Secrets Manager path'),
        externalSecretYaml: z => z.string().describe('ExternalSecret manifest (ready to commit)'),
      },
    },

    async handler(ctx) {
      const {
        serviceName,
        secretKey,
        secretValue,
        awsRegion = 'us-east-1',
        secretPathPrefix = 'idp-mvp/services',
      } = ctx.input;

      const secretPath = `${secretPathPrefix}/${serviceName}/${secretKey}`;

      ctx.logger.info(
        `Provisioning secret at ${secretPath} in ${awsRegion}...`,
      );

      const client = new SecretsManagerClient({ region: awsRegion });

      let secretArn: string;

      try {
        const createCmd = new CreateSecretCommand({
          Name: secretPath,
          SecretString: secretValue,
          Description: `Managed by IDP — service: ${serviceName}, key: ${secretKey}`,
          Tags: [
            { Key: 'managed-by', Value: 'idp-backstage' },
            { Key: 'service', Value: serviceName },
          ],
        });
        const result = await client.send(createCmd);
        secretArn = result.ARN ?? secretPath;
        ctx.logger.info(`Secret created: ${secretArn}`);
      } catch (err: any) {
        if (err instanceof ResourceExistsException || err.name === 'ResourceExistsException') {
          ctx.logger.info(`Secret already exists at ${secretPath} — updating value...`);
          // Fetch ARN from existing secret
          const getCmd = new GetSecretValueCommand({ SecretId: secretPath });
          const existing = await client.send(getCmd);
          secretArn = existing.ARN ?? secretPath;

          const putCmd = new PutSecretValueCommand({
            SecretId: secretPath,
            SecretString: secretValue,
          });
          await client.send(putCmd);
          ctx.logger.info(`Secret updated.`);
        } else {
          throw new Error(
            `Failed to provision secret at ${secretPath}: ${err.message}`,
          );
        }
      }

      // Build the ExternalSecret manifest that teams commit to their service repo
      const externalSecretYaml = `apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: ${serviceName}-${secretKey.toLowerCase().replace(/_/g, '-')}
  namespace: services
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws-secretsmanager
    kind: ClusterSecretStore
  target:
    name: ${serviceName}-secrets
    creationPolicy: Merge
  data:
    - secretKey: ${secretKey}
      remoteRef:
        key: ${secretPath}
`;

      ctx.logger.info(
        `ExternalSecret manifest ready — commit k8s/secrets/external-secret.yaml to your service repo.`,
      );

      ctx.output('secretArn', secretArn);
      ctx.output('secretPath', secretPath);
      ctx.output('externalSecretYaml', externalSecretYaml);
    },
  });
}

export const idpProvisionSecretModule = createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'idp-provision-secret',
  register(env) {
    env.registerInit({
      deps: {
        scaffolder: scaffolderActionsExtensionPoint,
      },
      async init({ scaffolder }) {
        scaffolder.addActions(createProvisionSecretAction());
      },
    });
  },
});
