import type { ActionContext } from '@backstage/plugin-scaffolder-node';
import type { ScmIntegrations } from '@backstage/integration';

jest.mock('@backstage/integration', () => ({
  DefaultGithubCredentialsProvider: {
    fromIntegrations: jest.fn().mockReturnValue({ getCredentials: jest.fn() }),
  },
  ScmIntegrations: {},
}));

const mockGetEntityByName = jest.fn();
jest.mock('@backstage/catalog-client', () => ({
  CatalogClient: jest.fn().mockImplementation(() => ({
    getEntityByName: (...args: any[]) => mockGetEntityByName(...args),
  })),
}));

import { createDecommissionServiceAction } from '../idpDecommissionService';
import { DefaultGithubCredentialsProvider } from '@backstage/integration';

const mockGetCredentials = (DefaultGithubCredentialsProvider.fromIntegrations as jest.Mock)(
  undefined,
).getCredentials as jest.Mock;

function makeCtx(input: Record<string, unknown>, userRef: string | null = 'user:default/alice') {
  const outputs: Record<string, unknown> = {};
  const ctx = {
    input,
    user: userRef !== null ? { ref: userRef } : undefined,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    output: (name: string, value: unknown) => {
      outputs[name] = value;
    },
  } as unknown as ActionContext<any, any, any>;
  return { ctx, outputs };
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

const options = {
  integrations: {} as ScmIntegrations,
  discovery: { getBaseUrl: jest.fn().mockResolvedValue('http://catalog.internal') },
  auth: {
    getOwnServiceCredentials: jest.fn().mockResolvedValue({}),
    getPluginRequestToken: jest.fn().mockResolvedValue({ token: 'plugin-token' }),
  },
};

describe('idp:decommission-service', () => {
  const action = createDecommissionServiceAction(options);

  beforeEach(() => {
    mockGetEntityByName.mockReset();
    mockGetCredentials.mockReset().mockResolvedValue({ token: 'gh-integration-token' });
    options.discovery.getBaseUrl.mockClear();
    options.auth.getPluginRequestToken.mockClear();
  });

  it('rejects a malformed entityRef before touching the catalog or GitHub', async () => {
    const { ctx } = makeCtx({ entityRef: 'not-a-valid-ref', action: 'archive', confirmationText: 'x' });
    await expect(action.handler(ctx)).rejects.toThrow(/Invalid entityRef format/);
    expect(mockGetEntityByName).not.toHaveBeenCalled();
  });

  it('rejects when the typed confirmation does not match the service name', async () => {
    const { ctx } = makeCtx({
      entityRef: 'component:default/payments-api',
      action: 'archive',
      confirmationText: 'wrong-name',
    });
    await expect(action.handler(ctx)).rejects.toThrow(/Confirmation text does not match/);
    expect(mockGetEntityByName).not.toHaveBeenCalled();
  });

  it('rejects when the caller identity cannot be determined', async () => {
    const { ctx } = makeCtx(
      { entityRef: 'component:default/payments-api', action: 'archive', confirmationText: 'payments-api' },
      null,
    );
    await expect(action.handler(ctx)).rejects.toThrow(/Cannot determine current user entity ref/);
  });

  // Regression test for the bug documented in idpDecommissionService.ts: the
  // membership check used to live inside the try/catch around the catalog
  // fetch, so its throw was swallowed as a warning and decommission proceeded
  // for anyone. This must actually block a non-member.
  it('blocks a caller who is not a member of platform-team', async () => {
    mockGetEntityByName.mockResolvedValue({
      spec: { memberOf: ['group:default/some-other-team'] },
    });
    mockFetchSequence([]); // no fetch should be reached
    const { ctx } = makeCtx({
      entityRef: 'component:default/payments-api',
      action: 'archive',
      confirmationText: 'payments-api',
    });
    await expect(action.handler(ctx)).rejects.toThrow(/must be a member of the platform-team group/);
  });

  it('allows a platform-team member to proceed', async () => {
    mockGetEntityByName.mockResolvedValue({
      spec: { memberOf: ['group:default/platform-team'] },
    });
    const fetchMock = mockFetchSequence([
      // entity lookup — no project-slug annotation, so GitHub is skipped
      { ok: true, json: { metadata: { uid: 'uid-1', annotations: {} } } },
      // catalog unregister
      { ok: true, status: 204 },
    ]);
    const { ctx, outputs } = makeCtx({
      entityRef: 'component:default/payments-api',
      action: 'archive',
      confirmationText: 'payments-api',
    });
    await action.handler(ctx);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(outputs.summary).toContain('no GitHub repo');
  });

  it('proceeds without a group check when the user entity cannot be fetched (fail-open, matches documented behaviour)', async () => {
    mockGetEntityByName.mockRejectedValue(new Error('catalog unreachable'));
    const fetchMock = mockFetchSequence([
      { ok: true, json: { metadata: { uid: 'uid-1', annotations: {} } } },
      { ok: true, status: 204 },
    ]);
    const { ctx } = makeCtx({
      entityRef: 'component:default/payments-api',
      action: 'archive',
      confirmationText: 'payments-api',
    });
    await action.handler(ctx);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((ctx.logger.warn as jest.Mock).mock.calls.some(c => String(c[0]).includes('Proceeding without group verification'))).toBe(true);
  });

  it('archives the GitHub repo, strips IDP topics, and unregisters the catalog entity', async () => {
    mockGetEntityByName.mockResolvedValue({ spec: { memberOf: ['group:default/platform-team'] } });
    const fetchMock = mockFetchSequence([
      { ok: true, json: { metadata: { uid: 'uid-1', annotations: { 'github.com/project-slug': 'acme/payments-api' } } } },
      { ok: true, status: 200 }, // PATCH archive
      { ok: true, json: { names: ['idp', 'idp-service', 'payments'] } }, // GET topics
      { ok: true, status: 200 }, // PUT topics
      { ok: true, status: 204 }, // unregister
    ]);
    const { ctx, outputs } = makeCtx({
      entityRef: 'component:default/payments-api',
      action: 'archive',
      confirmationText: 'payments-api',
    });
    await action.handler(ctx);

    expect(fetchMock.mock.calls[1][0]).toBe('https://api.github.com/repos/acme/payments-api');
    expect(fetchMock.mock.calls[1][1].method).toBe('PATCH');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ archived: true });

    const topicsPut = fetchMock.mock.calls[3];
    expect(topicsPut[1].method).toBe('PUT');
    expect(JSON.parse(topicsPut[1].body).names).toEqual(['payments']);

    expect(outputs.summary).toContain('acme/payments-api');
    expect(outputs.summary).toContain('archived');
  });

  it('surfaces a specific message when GitHub archive returns 403', async () => {
    mockGetEntityByName.mockResolvedValue({ spec: { memberOf: ['group:default/platform-team'] } });
    mockFetchSequence([
      { ok: true, json: { metadata: { uid: 'uid-1', annotations: { 'github.com/project-slug': 'acme/payments-api' } } } },
      { ok: false, status: 403, text: 'insufficient scope' },
    ]);
    const { ctx } = makeCtx({
      entityRef: 'component:default/payments-api',
      action: 'archive',
      confirmationText: 'payments-api',
    });
    await expect(action.handler(ctx)).rejects.toThrow(/GITHUB_TOKEN has 'repo' scope/);
  });

  it('does not fail the action when stripping IDP topics fails — best-effort only', async () => {
    mockGetEntityByName.mockResolvedValue({ spec: { memberOf: ['group:default/platform-team'] } });
    const fetchMock = mockFetchSequence([
      { ok: true, json: { metadata: { uid: 'uid-1', annotations: { 'github.com/project-slug': 'acme/payments-api' } } } },
      { ok: true, status: 200 }, // PATCH archive
      { ok: false, status: 500, text: 'topics unavailable' }, // GET topics fails
      { ok: true, status: 204 }, // unregister still happens
    ]);
    const { ctx, outputs } = makeCtx({
      entityRef: 'component:default/payments-api',
      action: 'archive',
      confirmationText: 'payments-api',
    });
    await action.handler(ctx);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(outputs.summary).toContain('archived');
  });

  it('permanently deletes the repo when action is delete, with a 403-specific message on failure', async () => {
    mockGetEntityByName.mockResolvedValue({ spec: { memberOf: ['group:default/platform-team'] } });
    mockFetchSequence([
      { ok: true, json: { metadata: { uid: 'uid-1', annotations: { 'github.com/project-slug': 'acme/payments-api' } } } },
      { ok: false, status: 403, text: 'insufficient scope' },
    ]);
    const { ctx } = makeCtx({
      entityRef: 'component:default/payments-api',
      action: 'delete',
      confirmationText: 'payments-api',
    });
    await expect(action.handler(ctx)).rejects.toThrow(/GITHUB_TOKEN has 'delete_repo' scope/);
  });

  it('deletes the GitHub repo and unregisters the catalog entity on the happy path', async () => {
    mockGetEntityByName.mockResolvedValue({ spec: { memberOf: ['group:default/platform-team'] } });
    const fetchMock = mockFetchSequence([
      { ok: true, json: { metadata: { uid: 'uid-1', annotations: { 'github.com/project-slug': 'acme/payments-api' } } } },
      { ok: true, status: 204 }, // DELETE repo
      { ok: true, status: 204 }, // unregister
    ]);
    const { ctx, outputs } = makeCtx({
      entityRef: 'component:default/payments-api',
      action: 'delete',
      confirmationText: 'payments-api',
    });
    await action.handler(ctx);
    expect(fetchMock.mock.calls[1][1].method).toBe('DELETE');
    expect(outputs.summary).toContain('deleted');
  });

  it('treats a 404 on catalog unregister as success (entity already gone)', async () => {
    mockGetEntityByName.mockResolvedValue({ spec: { memberOf: ['group:default/platform-team'] } });
    const fetchMock = mockFetchSequence([
      { ok: true, json: { metadata: { uid: 'uid-1', annotations: {} } } },
      { ok: false, status: 404, text: 'not found' },
    ]);
    const { ctx } = makeCtx({
      entityRef: 'component:default/payments-api',
      action: 'archive',
      confirmationText: 'payments-api',
    });
    await expect(action.handler(ctx)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws when catalog unregister fails with a non-404 error', async () => {
    mockGetEntityByName.mockResolvedValue({ spec: { memberOf: ['group:default/platform-team'] } });
    mockFetchSequence([
      { ok: true, json: { metadata: { uid: 'uid-1', annotations: {} } } },
      { ok: false, status: 500, text: 'db error' },
    ]);
    const { ctx } = makeCtx({
      entityRef: 'component:default/payments-api',
      action: 'archive',
      confirmationText: 'payments-api',
    });
    await expect(action.handler(ctx)).rejects.toThrow(/Failed to unregister entity/);
  });
});
