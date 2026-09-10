/**
 * Shared plumbing for the GitHub Actions repo-config actions
 * (idp:repo:set-secrets, idp:repo:set-variables) — owner/repo URL parsing,
 * credential lookup, and the settled-results summary loop were previously
 * duplicated verbatim between the two modules.
 */
import {
  DefaultGithubCredentialsProvider,
  ScmIntegrations,
} from '@backstage/integration';

/**
 * Parses either the Backstage RepoUrlPicker format
 * (github.com?owner=X&repo=Y) or a standard HTTPS/git URL
 * (https://github.com/owner/repo).
 */
export function parseGithubOwnerRepo(repoUrl: string): { owner: string; repo: string } {
  const pathMatch = repoUrl.match(/github\.com[/:]([^/?]+)\/([^/?]+?)(?:\.git)?(?:[/?].*)?$/);
  if (pathMatch) {
    return { owner: pathMatch[1], repo: pathMatch[2] };
  }
  const urlStr = repoUrl.startsWith('http') ? repoUrl : `https://${repoUrl}`;
  const parsed = new URL(urlStr);
  const owner = parsed.searchParams.get('owner') ?? '';
  const repo = parsed.searchParams.get('repo') ?? '';
  if (!owner || !repo) {
    throw new Error(`Cannot parse GitHub owner/repo from URL: ${repoUrl}`);
  }
  return { owner, repo };
}

/** GitHub token via the Backstage SCM integration, plus the REST API headers built from it. */
export async function getGithubApiHeaders(
  integrations: ScmIntegrations,
  owner: string,
  repo: string,
): Promise<Record<string, string>> {
  const httpsUrl = `https://github.com/${owner}/${repo}`;
  const credProvider = DefaultGithubCredentialsProvider.fromIntegrations(integrations);
  const { token } = await credProvider.getCredentials({ url: httpsUrl });
  return {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

/**
 * Logs the outcome of a Promise.allSettled batch (one entry set/failed per
 * secret or variable) and returns the names that succeeded.
 */
export function summarizeSettledResults(
  settled: PromiseSettledResult<string>[],
  entries: Array<[string, string]>,
  kind: 'Secret' | 'Variable',
  ownerRepo: string,
  logger: { info(message: string): void; warn(message: string): void },
): string[] {
  const results: string[] = [];
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    const name = entries[i][0];
    if (s.status === 'fulfilled') {
      logger.info(`${kind} ${name} set on ${ownerRepo}`);
      results.push(name);
    } else {
      logger.warn(
        `Failed to set ${kind.toLowerCase()} ${name}: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`,
      );
    }
  }
  return results;
}
