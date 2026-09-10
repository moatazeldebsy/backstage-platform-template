const mockGetCredentials = jest.fn();
jest.mock('@backstage/integration', () => ({
  DefaultGithubCredentialsProvider: {
    fromIntegrations: jest.fn().mockReturnValue({ getCredentials: (...args: any[]) => mockGetCredentials(...args) }),
  },
  ScmIntegrations: {},
}));

import { parseGithubOwnerRepo, getGithubApiHeaders, summarizeSettledResults } from '../githubRepoHelpers';
import type { ScmIntegrations } from '@backstage/integration';

describe('parseGithubOwnerRepo', () => {
  it('parses a plain https://github.com/owner/repo URL', () => {
    expect(parseGithubOwnerRepo('https://github.com/acme/payments-api')).toEqual({
      owner: 'acme',
      repo: 'payments-api',
    });
  });

  it('parses a .git-suffixed URL', () => {
    expect(parseGithubOwnerRepo('https://github.com/acme/payments-api.git')).toEqual({
      owner: 'acme',
      repo: 'payments-api',
    });
  });

  it('parses an SSH-style URL (github.com:owner/repo)', () => {
    expect(parseGithubOwnerRepo('git@github.com:acme/payments-api.git')).toEqual({
      owner: 'acme',
      repo: 'payments-api',
    });
  });

  it('parses the Backstage RepoUrlPicker format (github.com?owner=X&repo=Y)', () => {
    expect(parseGithubOwnerRepo('github.com?owner=acme&repo=payments-api')).toEqual({
      owner: 'acme',
      repo: 'payments-api',
    });
  });

  it('throws when owner/repo cannot be determined from the URL', () => {
    expect(() => parseGithubOwnerRepo('https://example.com/not-github')).toThrow(
      /Cannot parse GitHub owner\/repo/,
    );
  });
});

describe('getGithubApiHeaders', () => {
  beforeEach(() => {
    mockGetCredentials.mockReset().mockResolvedValue({ token: 'gh-token-123' });
  });

  it('builds standard GitHub REST headers from the integration credential', async () => {
    const headers = await getGithubApiHeaders({} as ScmIntegrations, 'acme', 'payments-api');
    expect(headers).toEqual({
      Authorization: 'token gh-token-123',
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    });
  });

  it('looks up credentials for the https URL built from owner/repo', async () => {
    await getGithubApiHeaders({} as ScmIntegrations, 'acme', 'payments-api');
    expect(mockGetCredentials).toHaveBeenCalledWith({ url: 'https://github.com/acme/payments-api' });
  });
});

describe('summarizeSettledResults', () => {
  function makeLogger() {
    return { info: jest.fn(), warn: jest.fn() };
  }

  it('logs and returns the names of fulfilled entries', () => {
    const settled: PromiseSettledResult<string>[] = [
      { status: 'fulfilled', value: 'FOO' },
      { status: 'fulfilled', value: 'BAR' },
    ];
    const entries: Array<[string, string]> = [['FOO', 'x'], ['BAR', 'y']];
    const logger = makeLogger();

    const results = summarizeSettledResults(settled, entries, 'Secret', 'acme/payments-api', logger);

    expect(results).toEqual(['FOO', 'BAR']);
    expect(logger.info).toHaveBeenCalledWith('Secret FOO set on acme/payments-api');
    expect(logger.info).toHaveBeenCalledWith('Secret BAR set on acme/payments-api');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns on rejected entries with a lowercase kind, and excludes them from the returned names', () => {
    const settled: PromiseSettledResult<string>[] = [
      { status: 'rejected', reason: new Error('boom') },
    ];
    const entries: Array<[string, string]> = [['BAD', 'x']];
    const logger = makeLogger();

    const results = summarizeSettledResults(settled, entries, 'Variable', 'acme/payments-api', logger);

    expect(results).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith('Failed to set variable BAD: boom');
  });

  it('stringifies a non-Error rejection reason', () => {
    const settled: PromiseSettledResult<string>[] = [
      { status: 'rejected', reason: 'status=500' },
    ];
    const entries: Array<[string, string]> = [['BAD', 'x']];
    const logger = makeLogger();

    summarizeSettledResults(settled, entries, 'Secret', 'acme/payments-api', logger);

    expect(logger.warn).toHaveBeenCalledWith('Failed to set secret BAD: status=500');
  });
});
