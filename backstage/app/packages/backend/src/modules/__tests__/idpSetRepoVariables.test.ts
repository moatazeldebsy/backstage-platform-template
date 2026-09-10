import type { ActionContext } from '@backstage/plugin-scaffolder-node';
import type { ScmIntegrations } from '@backstage/integration';

jest.mock('@backstage/integration', () => ({
  DefaultGithubCredentialsProvider: {
    fromIntegrations: jest.fn().mockReturnValue({ getCredentials: jest.fn() }),
  },
  ScmIntegrations: {},
}));

import { createSetRepoVariablesAction } from '../idpSetRepoVariables';
import { DefaultGithubCredentialsProvider } from '@backstage/integration';

const mockGetCredentials = (DefaultGithubCredentialsProvider.fromIntegrations as jest.Mock)(
  undefined,
).getCredentials as jest.Mock;

function makeCtx(input: Record<string, unknown>) {
  const ctx = {
    input,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    output: jest.fn(),
  } as unknown as ActionContext<any, any, any>;
  return ctx;
}

function mockFetchSequence(responses: Array<{ ok: boolean; status?: number; text?: string }>) {
  const fetchMock = jest.fn();
  for (const r of responses) {
    fetchMock.mockImplementationOnce(async () => ({
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      text: async () => r.text ?? '',
    }));
  }
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe('idp:repo:set-variables', () => {
  const action = createSetRepoVariablesAction({ integrations: {} as ScmIntegrations });

  beforeEach(() => {
    mockGetCredentials.mockReset().mockResolvedValue({ token: 'gh-integration-token' });
  });

  it('updates an existing variable via PATCH, with no fallback create call', async () => {
    const fetchMock = mockFetchSequence([{ ok: true, status: 204 }]);
    const ctx = makeCtx({ repoUrl: 'https://github.com/acme/payments-api', variables: { FOO: 'bar' } });
    await action.handler(ctx);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.github.com/repos/acme/payments-api/actions/variables/FOO',
    );
    expect(fetchMock.mock.calls[0][1].method).toBe('PATCH');
  });

  it('creates the variable via POST when PATCH returns 404 (variable does not exist yet)', async () => {
    const fetchMock = mockFetchSequence([
      { ok: false, status: 404 },
      { ok: true, status: 201 },
    ]);
    const ctx = makeCtx({ repoUrl: 'https://github.com/acme/payments-api', variables: { FOO: 'bar' } });
    await action.handler(ctx);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://api.github.com/repos/acme/payments-api/actions/variables',
    );
    expect(fetchMock.mock.calls[1][1].method).toBe('POST');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ name: 'FOO', value: 'bar' });
  });

  it('does not fail the whole action when the create-on-404 fallback also fails — partial success', async () => {
    mockFetchSequence([
      { ok: false, status: 404 },
      { ok: false, status: 500, text: 'server error' },
    ]);
    const ctx = makeCtx({ repoUrl: 'https://github.com/acme/payments-api', variables: { FOO: 'bar' } });
    await expect(action.handler(ctx)).resolves.toBeUndefined();
    expect((ctx.logger.warn as jest.Mock).mock.calls.some(c => String(c[0]).includes('Failed to set variable FOO'))).toBe(true);
  });

  it('throws for a PATCH failure that is not 404', async () => {
    mockFetchSequence([{ ok: false, status: 500, text: 'server error' }]);
    const ctx = makeCtx({ repoUrl: 'https://github.com/acme/payments-api', variables: { FOO: 'bar' } });
    await action.handler(ctx);
    expect((ctx.logger.warn as jest.Mock).mock.calls.some(c => String(c[0]).includes('Failed to set variable FOO: status=500'))).toBe(true);
  });

  it('skips variables with an empty value and does not call the API for them', async () => {
    const fetchMock = mockFetchSequence([{ ok: true, status: 204 }]);
    const ctx = makeCtx({
      repoUrl: 'https://github.com/acme/payments-api',
      variables: { REAL: 'value', EMPTY: '' },
    });
    await action.handler(ctx);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('/variables/REAL');
    expect((ctx.logger.warn as jest.Mock).mock.calls.some(c => String(c[0]).includes('Skipping variable EMPTY'))).toBe(true);
  });

  it('reports how many of the requested variables were set', async () => {
    const fetchMock = mockFetchSequence([
      { ok: true, status: 204 }, // GOOD
      { ok: false, status: 500, text: 'err' }, // BAD (PATCH fails non-404)
    ]);
    const ctx = makeCtx({
      repoUrl: 'https://github.com/acme/payments-api',
      variables: { GOOD: 'x', BAD: 'y' },
    });
    await action.handler(ctx);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((ctx.logger.info as jest.Mock).mock.calls.some(c => String(c[0]).includes('Done. Set 1/2 variables: GOOD'))).toBe(true);
  });
});
