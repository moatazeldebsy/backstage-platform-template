import type { ActionContext } from '@backstage/plugin-scaffolder-node';
import type { ScmIntegrations } from '@backstage/integration';

jest.mock('@backstage/integration', () => ({
  DefaultGithubCredentialsProvider: {
    fromIntegrations: jest.fn().mockReturnValue({ getCredentials: jest.fn() }),
  },
  ScmIntegrations: {},
}));

import { createSetRepoSecretsAction } from '../idpSetRepoSecrets';
import { DefaultGithubCredentialsProvider } from '@backstage/integration';

const mockGetCredentials = (DefaultGithubCredentialsProvider.fromIntegrations as jest.Mock)(
  undefined,
).getCredentials as jest.Mock;

const ENV_KEYS = [
  'GITHUB_TOKEN',
  'SONAR_TOKEN',
  'SNYK_TOKEN',
  'GCP_SERVICE_ACCOUNT_KEY',
  'LT_USERNAME',
  'LT_ACCESS_KEY',
  'BROWSERSTACK_USERNAME',
  'BROWSERSTACK_ACCESS_KEY',
  'SAUCE_USERNAME',
  'SAUCE_ACCESS_KEY',
];

function makeCtx(input: Record<string, unknown>) {
  const ctx = {
    input,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    output: jest.fn(),
  } as unknown as ActionContext<any, any, any>;
  return ctx;
}

/** A well-formed 32-byte libsodium sealed-box public key, base64-encoded. */
const FAKE_PUBLIC_KEY = Buffer.alloc(32, 7).toString('base64');

function mockFetchSequence(responses: Array<{ ok: boolean; status?: number; json?: any; text?: string }>) {
  const fetchMock = jest.fn();
  for (const r of responses) {
    fetchMock.mockImplementationOnce(async () => ({
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      json: async () => r.json,
      text: async () => r.text ?? '',
    }));
  }
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe('idp:repo:set-secrets', () => {
  const action = createSetRepoSecretsAction({ integrations: {} as ScmIntegrations });
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
    ENV_KEYS.forEach(k => delete process.env[k]);
    mockGetCredentials.mockReset().mockResolvedValue({ token: 'gh-integration-token' });
  });

  afterEach(() => {
    ENV_KEYS.forEach(k => {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k]!;
    });
  });

  it('parses a plain https://github.com/owner/repo URL', async () => {
    const fetchMock = mockFetchSequence([
      { ok: true, json: { key: FAKE_PUBLIC_KEY, key_id: 'k1' } },
      { ok: true, status: 204 },
    ]);
    const ctx = makeCtx({ repoUrl: 'https://github.com/acme/payments-api', secrets: { FOO: 'bar' } });
    await action.handler(ctx);

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.github.com/repos/acme/payments-api/actions/secrets/public-key',
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://api.github.com/repos/acme/payments-api/actions/secrets/FOO',
    );
  });

  it('parses the Backstage RepoUrlPicker format (github.com?owner=X&repo=Y)', async () => {
    const fetchMock = mockFetchSequence([
      { ok: true, json: { key: FAKE_PUBLIC_KEY, key_id: 'k1' } },
      { ok: true, status: 204 },
    ]);
    const ctx = makeCtx({
      repoUrl: 'github.com?owner=acme&repo=payments-api',
      secrets: { FOO: 'bar' },
    });
    await action.handler(ctx);

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.github.com/repos/acme/payments-api/actions/secrets/public-key',
    );
  });

  it('throws when owner/repo cannot be determined from the URL', async () => {
    const ctx = makeCtx({ repoUrl: 'https://example.com/not-github', secrets: { FOO: 'bar' } });
    await expect(action.handler(ctx)).rejects.toThrow(/Cannot parse GitHub owner\/repo/);
  });

  it('auto-injects platform secrets from the environment when not already supplied', async () => {
    process.env.SONAR_TOKEN = 'sonar-abc';
    process.env.GITHUB_TOKEN = 'gh-platform-pat';
    const fetchMock = mockFetchSequence([
      { ok: true, json: { key: FAKE_PUBLIC_KEY, key_id: 'k1' } },
      { ok: true, status: 204 }, // IDP_PLATFORM_TOKEN
      { ok: true, status: 204 }, // SONAR_TOKEN
    ]);
    const ctx = makeCtx({ repoUrl: 'https://github.com/acme/payments-api', secrets: {} });
    await action.handler(ctx);

    const putUrls = fetchMock.mock.calls.slice(1).map(c => c[0]);
    expect(putUrls).toContain('https://api.github.com/repos/acme/payments-api/actions/secrets/IDP_PLATFORM_TOKEN');
    expect(putUrls).toContain('https://api.github.com/repos/acme/payments-api/actions/secrets/SONAR_TOKEN');
  });

  it('never overwrites a user-supplied secret with an auto-injected one', async () => {
    process.env.SONAR_TOKEN = 'env-value';
    const fetchMock = mockFetchSequence([
      { ok: true, json: { key: FAKE_PUBLIC_KEY, key_id: 'k1' } },
      { ok: true, status: 204 },
    ]);
    const ctx = makeCtx({
      repoUrl: 'https://github.com/acme/payments-api',
      secrets: { SONAR_TOKEN: 'user-supplied-value' },
    });
    await action.handler(ctx);

    // Only one secret PUT — user's SONAR_TOKEN wasn't duplicated or replaced by the env one.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('skips secrets with an empty value and does not call the API for them', async () => {
    const fetchMock = mockFetchSequence([
      { ok: true, json: { key: FAKE_PUBLIC_KEY, key_id: 'k1' } },
      { ok: true, status: 204 },
    ]);
    const ctx = makeCtx({
      repoUrl: 'https://github.com/acme/payments-api',
      secrets: { REAL: 'value', EMPTY: '' },
    });
    await action.handler(ctx);

    // public-key fetch + exactly one PUT (for REAL only)
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toContain('/secrets/REAL');
  });

  it('throws if the public-key fetch fails, and makes no PUT calls', async () => {
    const fetchMock = mockFetchSequence([{ ok: false, status: 404, text: 'Not Found' }]);
    const ctx = makeCtx({ repoUrl: 'https://github.com/acme/payments-api', secrets: { FOO: 'bar' } });
    await expect(action.handler(ctx)).rejects.toThrow(/Failed to fetch repo public key \(404\)/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not fail the whole action when one secret PUT fails — partial success', async () => {
    const fetchMock = mockFetchSequence([
      { ok: true, json: { key: FAKE_PUBLIC_KEY, key_id: 'k1' } },
      { ok: false, status: 500, text: 'server error' }, // BAD fails
      { ok: true, status: 204 }, // GOOD succeeds
    ]);
    const ctx = makeCtx({
      repoUrl: 'https://github.com/acme/payments-api',
      secrets: { BAD: 'x', GOOD: 'y' },
    });
    await expect(action.handler(ctx)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((ctx.logger.warn as jest.Mock).mock.calls.some(c => String(c[0]).includes('Failed to set secret BAD'))).toBe(true);
    expect((ctx.logger.info as jest.Mock).mock.calls.some(c => String(c[0]).includes('Secret GOOD set'))).toBe(true);
  });

  it('sends an encrypted_value and key_id in every PUT body', async () => {
    const fetchMock = mockFetchSequence([
      { ok: true, json: { key: FAKE_PUBLIC_KEY, key_id: 'the-key-id' } },
      { ok: true, status: 204 },
    ]);
    const ctx = makeCtx({ repoUrl: 'https://github.com/acme/payments-api', secrets: { FOO: 'bar' } });
    await action.handler(ctx);

    const putCall = fetchMock.mock.calls[1];
    expect(putCall[1].method).toBe('PUT');
    const body = JSON.parse(putCall[1].body);
    expect(body.key_id).toBe('the-key-id');
    expect(typeof body.encrypted_value).toBe('string');
    expect(body.encrypted_value).not.toBe('bar');
    expect(body.encrypted_value.length).toBeGreaterThan(0);
  });
});
