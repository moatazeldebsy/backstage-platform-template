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

/**
 * Create-or-update one value in AWS Secrets Manager, idempotently.
 *
 * Extracted out of createProvisionSecretAction's handler so idpProvisionLitellmKey.ts
 * (ADR-0008 — LiteLLM virtual keys need the exact same store-once-return-never-again
 * handling a raw secret value gets everywhere else in this repo) can reuse it rather
 * than duplicating the SecretsManagerClient/ResourceExistsException dance.
 */
export async function provisionAwsSecret(opts: {
  secretPath: string;
  secretValue: string;
  description: string;
  tags: { Key: string; Value: string }[];
  awsRegion?: string;
}): Promise<{ secretArn: string }> {
  const { secretPath, secretValue, description, tags, awsRegion = 'us-east-1' } = opts;
  const client = new SecretsManagerClient({ region: awsRegion });

  try {
    const createCmd = new CreateSecretCommand({
      Name: secretPath,
      SecretString: secretValue,
      Description: description,
      Tags: tags,
    });
    const result = await client.send(createCmd);
    return { secretArn: result.ARN ?? secretPath };
  } catch (err: any) {
    if (err instanceof ResourceExistsException || err.name === 'ResourceExistsException') {
      const getCmd = new GetSecretValueCommand({ SecretId: secretPath });
      const existing = await client.send(getCmd);
      const putCmd = new PutSecretValueCommand({ SecretId: secretPath, SecretString: secretValue });
      await client.send(putCmd);
      return { secretArn: existing.ARN ?? secretPath };
    }
    throw new Error(`Failed to provision secret at ${secretPath}: ${err.message}`);
  }
}

export function createProvisionSecretAction() {
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

      const { secretArn } = await provisionAwsSecret({
        secretPath,
        secretValue,
        awsRegion,
        description: `Managed by IDP — service: ${serviceName}, key: ${secretKey}`,
        tags: [
          { Key: 'managed-by', Value: 'idp-backstage' },
          { Key: 'service', Value: serviceName },
        ],
      });
      ctx.logger.info(`Secret ready: ${secretArn}`);

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
