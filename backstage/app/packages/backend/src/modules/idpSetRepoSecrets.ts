/**
 * IDP scaffolder action: idp:repo:set-secrets
 *
 * Sets GitHub Actions secrets on a newly scaffolded repo immediately after
 * publish:github. Uses the Backstage GitHub integration token to call the
 * GitHub REST API with libsodium-wrappers encryption (required by GitHub).
 *
 * Secrets set on every service repo:
 *   AWS_ROLE_ARN           — OIDC role for ECR push + EKS deploy (from template input)
 *   IDP_PLATFORM_TOKEN     — PAT for checking out platform Helm chart (auto from $GITHUB_TOKEN)
 *   SONAR_TOKEN            — SonarCloud analysis upload (auto from $SONAR_TOKEN, if set)
 *   SNYK_TOKEN             — Snyk test/monitor (auto from $SNYK_TOKEN, if set)
 *   GCP_SERVICE_ACCOUNT_KEY — GCP service account JSON for Firebase Test Lab (auto from $GCP_SERVICE_ACCOUNT_KEY, if set)
 *   LT_USERNAME / LT_ACCESS_KEY — LambdaTest device farm + browser grid (auto from $LT_USERNAME / $LT_ACCESS_KEY, if set)
 *   BROWSERSTACK_* / SAUCE_* — BrowserStack and Sauce Labs device farms (auto, if set)
 *
 * Auto-injected secrets are pulled from the Backstage backend pod's environment
 * (local: docker-compose env file; AWS: K8s secret backstage-secrets). When the
 * env var is unset the secret is skipped — the per-service CI workflows already
 * guard their Sonar/Snyk steps on `env.SONAR_TOKEN != ''`, so missing tokens are
 * silently skipped rather than failed.
 */
import { createBackendModule, coreServices } from '@backstage/backend-plugin-api';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node';
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
        repoUrl: z =>
          z.string().describe('The remote URL of the GitHub repo (e.g. https://github.com/org/repo)'),
        secrets: z =>
          z.record(z.string()).describe('Map of secret name → value to set as GitHub Actions secrets'),
      },
    },

    async handler(ctx) {
      const repoUrl = ctx.input.repoUrl as string;

      // Auto-inject platform-wide secrets from the backend pod's environment.
      // GITHUB_TOKEN / SONAR_TOKEN / SNYK_TOKEN are sourced from local/backstage/.env
      // locally and K8s secret backstage-secrets (Secrets Manager: idp-mvp/backstage) on AWS.
      const secrets: Record<string, string> = { ...(ctx.input.secrets as Record<string, string>) };
      const autoInject: Array<[string, string | undefined]> = [
        ['IDP_PLATFORM_TOKEN',      process.env.GITHUB_TOKEN],
        ['SONAR_TOKEN',             process.env.SONAR_TOKEN],
        ['SNYK_TOKEN',              process.env.SNYK_TOKEN],
        ['GCP_SERVICE_ACCOUNT_KEY', process.env.GCP_SERVICE_ACCOUNT_KEY],
        ['LT_USERNAME',             process.env.LT_USERNAME],
        ['LT_ACCESS_KEY',           process.env.LT_ACCESS_KEY],
        ['BROWSERSTACK_USERNAME',   process.env.BROWSERSTACK_USERNAME],
        ['BROWSERSTACK_ACCESS_KEY', process.env.BROWSERSTACK_ACCESS_KEY],
        ['SAUCE_USERNAME',          process.env.SAUCE_USERNAME],
        ['SAUCE_ACCESS_KEY',        process.env.SAUCE_ACCESS_KEY],
      ];
      for (const [name, value] of autoInject) {
        if (value && !secrets[name]) secrets[name] = value;
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

      // Encrypt + PUT each secret in parallel. The previous sequential loop
      // made wall-clock time O(N × RTT); for ~5 secrets on a slow link this
      // dominated scaffold latency.
      const entries = Object.entries(secrets).filter(([name, value]) => {
        if (!value) {
          ctx.logger.warn(`Skipping secret ${name} — value is empty`);
          return false;
        }
        return true;
      });
      const settled = await Promise.allSettled(entries.map(async ([name, value]) => {
        const encryptedValue = await encryptSecret(publicKey, value);
        const setResp = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/actions/secrets/${name}`,
          {
            method: 'PUT',
            headers: ghHeaders,
            body: JSON.stringify({ encrypted_value: encryptedValue, key_id: keyId }),
          },
        );
        if (!(setResp.ok || setResp.status === 201 || setResp.status === 204)) {
          const body = await setResp.text();
          throw new Error(`status=${setResp.status}: ${body}`);
        }
        return name;
      }));
      const results: string[] = [];
      for (let i = 0; i < settled.length; i++) {
        const s = settled[i];
        const name = entries[i][0];
        if (s.status === 'fulfilled') {
          ctx.logger.info(`Secret ${name} set on ${owner}/${repo}`);
          results.push(name);
        } else {
          ctx.logger.warn(`Failed to set secret ${name}: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`);
        }
      }

      ctx.logger.info(`Done. Set ${results.length}/${entries.length} secrets: ${results.join(', ')}`);
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
