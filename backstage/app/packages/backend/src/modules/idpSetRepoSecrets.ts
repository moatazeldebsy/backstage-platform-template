/**
 * IDP scaffolder action: idp:repo:set-secrets
 *
 * Sets GitHub Actions secrets on a newly scaffolded repo immediately after
 * publish:github. Uses the Backstage GitHub integration token to call the
 * GitHub REST API with libsodium-wrappers encryption (required by GitHub).
 *
 * Secrets set on every service repo:
 *   AWS_ROLE_ARN       — OIDC role for ECR push + EKS deploy
 *   IDP_PLATFORM_TOKEN — PAT for checking out platform Helm chart
 */
import { createBackendModule, coreServices } from '@backstage/backend-plugin-api';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node/alpha';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import {
  DefaultGithubCredentialsProvider,
  ScmIntegrations,
} from '@backstage/integration';
import sodium from 'libsodium-wrappers';

async function encryptSecret(repoPublicKey: string, secretValue: string): Promise<string> {
  await sodium.ready;
  const keyBytes = Buffer.from(repoPublicKey, 'base64');
  const msgBytes = Buffer.from(secretValue, 'utf8');
  const encrypted = sodium.crypto_box_seal(msgBytes, keyBytes);
  return Buffer.from(encrypted).toString('base64');
}

function createSetRepoSecretsAction(options: { integrations: ScmIntegrations }) {
  return createTemplateAction({
    id: 'idp:repo:set-secrets',
    description:
      'Set GitHub Actions secrets on a newly scaffolded repository using the platform GitHub integration token.',
    schema: {
      input: {
        required: ['repoUrl', 'secrets'],
        type: 'object',
        properties: {
          repoUrl: {
            type: 'string',
            title: 'Repository URL',
            description: 'The remote URL of the GitHub repo (e.g. https://github.com/org/repo)',
          },
          secrets: {
            type: 'object',
            title: 'Secrets',
            description: 'Map of secret name → value to set as GitHub Actions secrets',
            additionalProperties: { type: 'string' },
          },
        },
      },
    },

    async handler(ctx) {
      const repoUrl = ctx.input['repoUrl'] as string;

      // Auto-inject IDP_PLATFORM_TOKEN from the pod's GITHUB_TOKEN env var
      // (set via K8s secret backstage-secrets → idp-mvp/backstage in Secrets Manager)
      const platformToken = process.env.GITHUB_TOKEN;
      const secrets: Record<string, string> = { ...(ctx.input['secrets'] as Record<string, string>) };
      if (platformToken && !secrets['IDP_PLATFORM_TOKEN']) {
        secrets['IDP_PLATFORM_TOKEN'] = platformToken;
      }

      // Parse owner/repo from either:
      //   - Backstage RepoUrlPicker format: github.com?owner=X&repo=Y
      //   - Standard HTTPS/git URL:         https://github.com/owner/repo
      let owner: string;
      let repo: string;
      const pathMatch = repoUrl.match(/github\.com[/:]([^/?]+)\/([^/?]+?)(?:\.git)?(?:[/?].*)?$/);
      if (pathMatch) {
        [, owner, repo] = pathMatch;
      } else {
        const urlStr = repoUrl.startsWith('http') ? repoUrl : `https://${repoUrl}`;
        const parsed = new URL(urlStr);
        owner = parsed.searchParams.get('owner') ?? '';
        repo = parsed.searchParams.get('repo') ?? '';
        if (!owner || !repo) {
          throw new Error(`Cannot parse GitHub owner/repo from URL: ${repoUrl}`);
        }
      }

      // Normalise to HTTPS URL for credential lookup
      const httpsUrl = `https://github.com/${owner}/${repo}`;

      // Get GitHub token from Backstage SCM integration config
      const credProvider = DefaultGithubCredentialsProvider.fromIntegrations(options.integrations);
      const { token } = await credProvider.getCredentials({ url: httpsUrl });

      const ghHeaders = {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      };

      // Fetch the repo's Actions public key (required for secret encryption)
      ctx.logger.info(`Fetching Actions public key for ${owner}/${repo}...`);
      const keyResp = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/actions/secrets/public-key`,
        { headers: ghHeaders },
      );
      if (!keyResp.ok) {
        const body = await keyResp.text();
        throw new Error(`Failed to fetch repo public key (${keyResp.status}): ${body}`);
      }
      const { key: publicKey, key_id: keyId } = (await keyResp.json()) as {
        key: string;
        key_id: string;
      };

      // Encrypt and set each secret
      const results: string[] = [];
      for (const [name, value] of Object.entries(secrets)) {
        if (!value) {
          ctx.logger.warn(`Skipping secret ${name} — value is empty`);
          continue;
        }
        const encryptedValue = await encryptSecret(publicKey, value);
        const setResp = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/actions/secrets/${name}`,
          {
            method: 'PUT',
            headers: ghHeaders,
            body: JSON.stringify({ encrypted_value: encryptedValue, key_id: keyId }),
          },
        );
        if (setResp.ok || setResp.status === 201 || setResp.status === 204) {
          ctx.logger.info(`Secret ${name} set on ${owner}/${repo}`);
          results.push(name);
        } else {
          const body = await setResp.text();
          ctx.logger.warn(`Failed to set secret ${name} (${setResp.status}): ${body}`);
        }
      }

      ctx.logger.info(`Done. Set ${results.length}/${Object.keys(secrets).length} secrets: ${results.join(', ')}`);
    },
  });
}

export const idpSetRepoSecretsModule = createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'idp-set-repo-secrets',
  register(env) {
    env.registerInit({
      deps: {
        scaffolder: scaffolderActionsExtensionPoint,
        config: coreServices.rootConfig,
      },
      async init({ scaffolder, config }) {
        const integrations = ScmIntegrations.fromConfig(config);
        scaffolder.addActions(createSetRepoSecretsAction({ integrations }));
      },
    });
  },
});
