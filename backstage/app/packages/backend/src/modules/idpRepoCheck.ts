import { createBackendPlugin, coreServices } from '@backstage/backend-plugin-api';
import { DefaultGithubCredentialsProvider, ScmIntegrations } from '@backstage/integration';
import { Router } from 'express';

// Repo-name check for scaffolder templates that create a new repository.
//
// Those templates used to find out that the name was taken only at their
// publish:github step, after the user had filled in the whole form and earlier
// steps had run ("Repository creation failed: name already exists on this
// account", observed 2026-09-26 with flutter-app). The NewRepoUrlPicker form
// field calls this route while the user types so the form can say so up front.
//
// It runs server-side because the check needs a GitHub token: the browser has
// none (guest users never will), and the platform's own GitHub integration
// token can see the org's private repos too.

export type RepoStatus = 'exists' | 'available' | 'unknown';

export interface RepoRef {
  host: string;
  owner: string;
  repo: string;
}

// GitHub owner/repo names: letters, digits, '-', '_' and '.'. Anything else is
// rejected before it reaches the URL we build.
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

/**
 * Parse a RepoUrlPicker value (`github.com?owner=acme&repo=payments`).
 * Returns null for anything incomplete or malformed.
 */
export function parseRepoUrl(value: unknown): RepoRef | null {
  if (typeof value !== 'string' || !value.includes('?')) return null;
  const [host, query] = value.split('?', 2);
  const params = new URLSearchParams(query);
  const owner = params.get('owner') ?? '';
  const repo = params.get('repo') ?? '';
  if (!host || !NAME.test(owner) || !NAME.test(repo)) return null;
  return { host, owner, repo };
}

/**
 * Ask GitHub whether owner/repo exists. 200 → exists, 404 → available.
 * Anything else (rate limit, outage, bad token) is 'unknown': the form must
 * not block on a check that could not be made — publish:github still reports
 * a real conflict, as it did before.
 */
export async function checkRepo(
  ref: RepoRef,
  apiBaseUrl: string,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<RepoStatus> {
  try {
    const res = await fetchImpl(`${apiBaseUrl}/repos/${ref.owner}/${ref.repo}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: `token ${token}` } : {}),
      },
    });
    if (res.status === 200) return 'exists';
    if (res.status === 404) return 'available';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

export const idpRepoCheckPlugin = createBackendPlugin({
  pluginId: 'idp-repo-check',
  register(env) {
    env.registerInit({
      deps: {
        config: coreServices.rootConfig,
        httpRouter: coreServices.httpRouter,
        httpAuth: coreServices.httpAuth,
        logger: coreServices.logger,
      },
      async init({ config, httpRouter, httpAuth, logger }) {
        const integrations = ScmIntegrations.fromConfig(config);
        const credentials = DefaultGithubCredentialsProvider.fromIntegrations(integrations);
        const router = Router();

        // GET /api/idp-repo-check/status?repoUrl=github.com?owner=x%26repo=y
        //   -> { status: 'exists' | 'available' | 'unknown' }
        // Signed-in users only (httpAuth rejects anything else). It does tell
        // a signed-in user whether a private repo name is taken; that is the
        // same information a failed publish:github already gave them.
        router.get('/status', async (req, res) => {
          await httpAuth.credentials(req, { allow: ['user'] });
          const ref = parseRepoUrl(req.query.repoUrl);
          if (!ref) {
            res.status(400).json({ error: 'repoUrl must look like github.com?owner=<owner>&repo=<repo>' });
            return;
          }
          const integration = integrations.github.byHost(ref.host);
          if (!integration) {
            // Not a GitHub host this platform is configured for — nothing to check.
            res.json({ status: 'unknown' });
            return;
          }
          let token: string | undefined;
          try {
            ({ token } = await credentials.getCredentials({
              url: `https://${ref.host}/${ref.owner}/${ref.repo}`,
            }));
          } catch (e: any) {
            logger.warn(`No GitHub credentials for ${ref.host}/${ref.owner}: ${e.message}`);
          }
          const apiBaseUrl = integration.config.apiBaseUrl ?? 'https://api.github.com';
          res.json({ status: await checkRepo(ref, apiBaseUrl, token) });
        });

        httpRouter.use(router);
        logger.info('idp-repo-check plugin initialized');
      },
    });
  },
});
