/**
 * "Does this new repository name already exist?" for NewRepoUrlPicker.
 *
 * Templates that create a repository used to discover a taken name only at
 * their publish:github step, after the form was filled in and earlier steps had
 * run (flutter-app, 2026-09-26: "Repository creation failed … name already
 * exists on this account"). The check itself runs in the backend
 * (idp-repo-check), which holds the GitHub token the browser does not have.
 */

export type RepoStatus = 'exists' | 'available' | 'unknown';

/** owner/repo from a RepoUrlPicker value, or null while it is incomplete. */
export function repoFromValue(value: unknown): { owner: string; repo: string } | null {
  if (typeof value !== 'string' || !value.includes('?')) return null;
  const params = new URLSearchParams(value.split('?', 2)[1]);
  const owner = params.get('owner');
  const repo = params.get('repo');
  return owner && repo ? { owner, repo } : null;
}

/**
 * The validation error for `value`, or null if the form may continue.
 *
 * Only a definite "exists" blocks. If the check cannot be made (backend or
 * GitHub unreachable, rate-limited, non-GitHub host) the form carries on and
 * publish:github reports any real conflict exactly as before — a flaky check
 * must never be the reason nobody can scaffold.
 */
export async function newRepoNameError(
  value: unknown,
  getStatus: (repoUrl: string) => Promise<RepoStatus>,
): Promise<string | null> {
  const ref = repoFromValue(value);
  if (!ref) return null; // incomplete — the stock picker validation reports that
  let status: RepoStatus;
  try {
    status = await getStatus(value as string);
  } catch {
    return null;
  }
  if (status !== 'exists') return null;
  return (
    `${ref.owner}/${ref.repo} already exists on GitHub. Choose another repository name ` +
    '(this template creates a new repository; it cannot reuse an existing one).'
  );
}
