/**
 * IDP scaffolder action: idp:repo:set-variables
 *
 * Sets GitHub Actions repository *variables* (not secrets) on a newly
 * scaffolded repo immediately after publish:github. Unlike secrets, variables
 * are plaintext and require no libsodium encryption, but use a distinct GitHub
 * REST endpoint (/actions/variables vs /actions/secrets).
 *
 * Used by the nodejs-service template to set CONTRACT_SERVER_URL, which
 * contract-check.yml reads via ${{ vars.CONTRACT_SERVER_URL }}.
 */
import { createBackendModule, coreServices } from '@backstage/backend-plugin-api';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import { ScmIntegrations } from '@backstage/integration';
import { parseGithubOwnerRepo, getGithubApiHeaders, summarizeSettledResults } from './githubRepoHelpers';

export function createSetRepoVariablesAction(options: { integrations: ScmIntegrations }) {
  return createTemplateAction({
    id: 'idp:repo:set-variables',
    description:
      'Set GitHub Actions repository variables on a newly scaffolded repository using the platform GitHub integration token.',
    schema: {
      input: {
        repoUrl: z =>
          z.string().describe('The remote URL of the GitHub repo (e.g. https://github.com/org/repo)'),
        variables: z =>
          z.record(z.string()).describe('Map of variable name → value to set as GitHub Actions repo variables'),
      },
    },

    async handler(ctx) {
      const repoUrl = ctx.input.repoUrl as string;
      const variables = ctx.input.variables as Record<string, string>;

      const { owner, repo } = parseGithubOwnerRepo(repoUrl);
      const ghHeaders = await getGithubApiHeaders(options.integrations, owner, repo);

      const entries = Object.entries(variables).filter(([name, value]) => {
        if (!value) {
          ctx.logger.warn(`Skipping variable ${name} — value is empty`);
          return false;
        }
        return true;
      });

      const settled = await Promise.allSettled(entries.map(async ([name, value]) => {
        const setResp = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/actions/variables/${name}`,
          {
            method: 'PATCH',
            headers: ghHeaders,
            body: JSON.stringify({ name, value }),
          },
        );
        if (setResp.status === 404) {
          const createResp = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/actions/variables`,
            {
              method: 'POST',
              headers: ghHeaders,
              body: JSON.stringify({ name, value }),
            },
          );
          if (!(createResp.ok || createResp.status === 201)) {
            const body = await createResp.text();
            throw new Error(`status=${createResp.status}: ${body}`);
          }
          return name;
        }
        if (!(setResp.ok || setResp.status === 204)) {
          const body = await setResp.text();
          throw new Error(`status=${setResp.status}: ${body}`);
        }
        return name;
      }));

      const results = summarizeSettledResults(settled, entries, 'Variable', `${owner}/${repo}`, ctx.logger);

      ctx.logger.info(`Done. Set ${results.length}/${entries.length} variables: ${results.join(', ')}`);
    },
  });
}

export const idpSetRepoVariablesModule = createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'idp-set-repo-variables',
  register(env) {
    env.registerInit({
      deps: {
        scaffolder: scaffolderActionsExtensionPoint,
        config: coreServices.rootConfig,
      },
      async init({ scaffolder, config }) {
        const integrations = ScmIntegrations.fromConfig(config);
        scaffolder.addActions(createSetRepoVariablesAction({ integrations }));
      },
    });
  },
});
