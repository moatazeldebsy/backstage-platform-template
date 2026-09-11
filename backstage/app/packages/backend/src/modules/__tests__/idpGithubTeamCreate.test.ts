import type { ActionContext } from '@backstage/plugin-scaffolder-node';
import type { ScmIntegrations } from '@backstage/integration';

jest.mock('@backstage/integration', () => ({
  DefaultGithubCredentialsProvider: {
    fromIntegrations: jest.fn().mockReturnValue({ getCredentials: jest.fn() }),
  },
  ScmIntegrations: {},
}));

import { createGithubTeamCreateAction } from '../idpGithubTeamCreate';
import { DefaultGithubCredentialsProvider } from '@backstage/integration';

const mockGetCredentials = (DefaultGithubCredentialsProvider.fromIntegrations as jest.Mock)(
  undefined,
).getCredentials as jest.Mock;

function makeCtx(input: Record<string, unknown>) {
  return {
    input,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    output: jest.fn(),
  } as unknown as ActionContext<any, any, any>;
}

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

describe('idp:github:team-create', () => {
  const action = createGithubTeamCreateAction({ integrations: {} as ScmIntegrations });

  beforeEach(() => {
    mockGetCredentials.mockReset().mockResolvedValue({ token: 'gh-integration-token' });
  });

  it('creates a new team with no parent and no initial members', async () => {
    const fetchMock = mockFetchSequence([
      { ok: true, status: 201, json: { id: 1, slug: 'payments', html_url: 'https://github.com/orgs/acme/teams/payments' } },
    ]);
    const ctx = makeCtx({ org: 'acme', teamName: 'payments', platformRepo: 'platform' });
    await action.handler(ctx);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.github.com/orgs/acme/teams');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(ctx.output).toHaveBeenCalledWith('teamSlug', 'payments');
    expect(ctx.output).toHaveBeenCalledWith('created', true);
    expect(ctx.output).toHaveBeenCalledWith('membersAdded', []);
  });

  it('resolves the parent team id and nests the new team under it', async () => {
    const fetchMock = mockFetchSequence([
      { ok: true, status: 200, json: { id: 42, slug: 'platform-team', html_url: '' } }, // parent lookup
      { ok: true, status: 201, json: { id: 2, slug: 'payments', html_url: '' } }, // create
    ]);
    const ctx = makeCtx({
      org: 'acme',
      teamName: 'payments',
      parentTeamSlug: 'platform-team',
      platformRepo: 'platform',
    });
    await action.handler(ctx);

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.github.com/orgs/acme/teams/platform-team');
    const createBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(createBody.parent_team_id).toBe(42);
  });

  it('falls back to a top-level team when the parent team is not found', async () => {
    const fetchMock = mockFetchSequence([
      { ok: false, status: 404, text: 'Not Found' }, // parent lookup fails
      { ok: true, status: 201, json: { id: 3, slug: 'payments', html_url: '' } }, // create
    ]);
    const ctx = makeCtx({
      org: 'acme',
      teamName: 'payments',
      parentTeamSlug: 'missing-team',
      platformRepo: 'platform',
    });
    await action.handler(ctx);

    const createBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(createBody.parent_team_id).toBeUndefined();
    expect((ctx.logger.warn as jest.Mock).mock.calls.some(c => String(c[0]).includes('not found'))).toBe(true);
  });

  it('reuses an existing team when creation returns 422 already_exists', async () => {
    const fetchMock = mockFetchSequence([
      { ok: false, status: 422, text: 'Validation Failed' }, // create fails — already exists
      { ok: true, status: 200, json: { id: 5, slug: 'payments', html_url: 'https://github.com/orgs/acme/teams/payments' } }, // reuse lookup
    ]);
    const ctx = makeCtx({ org: 'acme', teamName: 'payments', platformRepo: 'platform' });
    await action.handler(ctx);

    expect(fetchMock.mock.calls[1][0]).toBe('https://api.github.com/orgs/acme/teams/payments');
    expect(ctx.output).toHaveBeenCalledWith('created', false);
  });

  it('throws when team creation fails for a reason other than already-exists', async () => {
    const fetchMock = mockFetchSequence([{ ok: false, status: 403, text: 'Forbidden' }]);
    const ctx = makeCtx({ org: 'acme', teamName: 'payments', platformRepo: 'platform' });
    await expect(action.handler(ctx)).rejects.toThrow(/Failed to create team "payments" \(403\)/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('adds initial members and reports partial success when one membership PUT fails', async () => {
    const fetchMock = mockFetchSequence([
      { ok: true, status: 201, json: { id: 1, slug: 'payments', html_url: '' } },
      { ok: true, status: 200 }, // alice succeeds
      { ok: false, status: 404, text: 'Not Found' }, // bob fails
    ]);
    const ctx = makeCtx({
      org: 'acme',
      teamName: 'payments',
      initialMembers: ['alice', 'bob'],
      platformRepo: 'platform',
    });
    await action.handler(ctx);

    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://api.github.com/orgs/acme/teams/payments/memberships/alice',
    );
    expect(ctx.output).toHaveBeenCalledWith('membersAdded', ['alice']);
    expect((ctx.logger.warn as jest.Mock).mock.calls.some(c => String(c[0]).includes('bob'))).toBe(true);
  });
});
