// The repo-name check exists so templates that create a repository fail in the
// form, not three steps into a run at publish:github (flutter-app, 2026-09-26).
// Two properties matter: a taken name is reported as taken, and a check that
// could not be made never blocks the form.
import { checkRepo, parseRepoUrl } from '../idpRepoCheck';

describe('parseRepoUrl', () => {
  it('parses a RepoUrlPicker value', () => {
    expect(parseRepoUrl('github.com?owner=moatazeldebsy&repo=flutter-demo')).toEqual({
      host: 'github.com',
      owner: 'moatazeldebsy',
      repo: 'flutter-demo',
    });
  });

  it('rejects incomplete values the picker emits while the user is still typing', () => {
    expect(parseRepoUrl('github.com?owner=acme')).toBeNull();
    expect(parseRepoUrl('github.com?repo=x')).toBeNull();
    expect(parseRepoUrl('github.com')).toBeNull();
    expect(parseRepoUrl(undefined)).toBeNull();
  });

  it('rejects names that could change the GitHub API path', () => {
    expect(parseRepoUrl('github.com?owner=acme&repo=../../user')).toBeNull();
    expect(parseRepoUrl('github.com?owner=acme/x&repo=y')).toBeNull();
    expect(parseRepoUrl('github.com?owner=acme&repo=a%3Fb')).toBeNull();
  });
});

describe('checkRepo', () => {
  const ref = { host: 'github.com', owner: 'acme', repo: 'payments' };
  const fetchReturning = (status: number) =>
    jest.fn().mockResolvedValue({ status }) as unknown as typeof fetch;

  it('reports an existing repository as exists, calling the right endpoint with the token', async () => {
    const fetchImpl = fetchReturning(200);
    await expect(checkRepo(ref, 'https://api.github.com', 'tkn', fetchImpl)).resolves.toBe('exists');
    const [url, init] = (fetchImpl as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/acme/payments');
    expect(init.headers.Authorization).toBe('token tkn');
  });

  it('reports a missing repository as available', async () => {
    await expect(checkRepo(ref, 'https://api.github.com', 'tkn', fetchReturning(404))).resolves.toBe('available');
  });

  it.each([401, 403, 500, 502])('reports %i as unknown so the form does not block', async status => {
    await expect(checkRepo(ref, 'https://api.github.com', 'tkn', fetchReturning(status))).resolves.toBe('unknown');
  });

  it('reports a network failure as unknown', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNRESET')) as unknown as typeof fetch;
    await expect(checkRepo(ref, 'https://api.github.com', 'tkn', fetchImpl)).resolves.toBe('unknown');
  });

  it('omits the Authorization header when there is no token', async () => {
    const fetchImpl = fetchReturning(404);
    await checkRepo(ref, 'https://api.github.com', undefined, fetchImpl);
    expect((fetchImpl as jest.Mock).mock.calls[0][1].headers.Authorization).toBeUndefined();
  });
});
