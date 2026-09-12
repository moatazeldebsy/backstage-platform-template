import { detectRegressions } from '../complianceWatcher/store';
import { postSlackRegression, createJiraIssue } from '../complianceWatcher/notify';

describe('detectRegressions', () => {
  it('returns nothing on the first observation (no previous state)', () => {
    expect(detectRegressions(undefined, { 'has-coverage-gate': true })).toEqual([]);
  });

  it('flags a check that flipped from true to false', () => {
    const previous = { 'has-coverage-gate': true, 'has-vuln-scan': true };
    const current = { 'has-coverage-gate': false, 'has-vuln-scan': true };
    expect(detectRegressions(previous, current)).toEqual(['has-coverage-gate']);
  });

  it('does not flag a check that was already false', () => {
    const previous = { 'has-coverage-gate': false };
    const current = { 'has-coverage-gate': false };
    expect(detectRegressions(previous, current)).toEqual([]);
  });

  it('does not flag a fact newly appearing (absent-in-previous is not a regression)', () => {
    const previous = { 'has-coverage-gate': true };
    const current = { 'has-coverage-gate': true, 'has-vuln-scan': true };
    expect(detectRegressions(previous, current)).toEqual([]);
  });

  it('treats a check disappearing entirely as a regression', () => {
    const previous = { 'has-coverage-gate': true };
    const current: Record<string, boolean> = {};
    expect(detectRegressions(previous, current)).toEqual(['has-coverage-gate']);
  });
});

describe('postSlackRegression', () => {
  const event = {
    entityRef: 'component:default/payments',
    entityName: 'payments',
    owner: 'team-payments',
    failedChecks: ['has-coverage-gate'],
  };

  it('is a no-op without a webhook URL configured', async () => {
    const fetchImpl = jest.fn();
    const sent = await postSlackRegression(event, { fetchImpl });
    expect(sent).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts to the configured webhook', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    const sent = await postSlackRegression(event, {
      webhookUrl: 'https://hooks.slack.com/services/x',
      fetchImpl,
    });
    expect(sent).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://hooks.slack.com/services/x',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('returns false without throwing when the webhook is unreachable', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('network down'));
    const sent = await postSlackRegression(event, {
      webhookUrl: 'https://hooks.slack.com/services/x',
      fetchImpl,
    });
    expect(sent).toBe(false);
  });
});

describe('createJiraIssue', () => {
  const event = {
    entityRef: 'component:default/payments',
    entityName: 'payments',
    failedChecks: ['has-vuln-scan'],
    jiraProjectKey: 'PAY',
  };

  it('is a no-op without jiraProjectKey', async () => {
    const fetchImpl = jest.fn();
    const result = await createJiraIssue(
      { ...event, jiraProjectKey: undefined },
      { baseUrl: 'https://x.atlassian.net', token: 'abc', fetchImpl },
    );
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('is a no-op without Jira credentials configured', async () => {
    const fetchImpl = jest.fn();
    const result = await createJiraIssue(event, { fetchImpl });
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('creates an issue via the cloud gateway (Bearer) when the site resolves a cloud ID', async () => {
    const fetchImpl = jest
      .fn()
      // resolveCloudId
      .mockResolvedValueOnce({ ok: true, json: async () => ({ cloudId: 'cloud-1' }) })
      // postIssue via gateway
      .mockResolvedValueOnce({ ok: true, json: async () => ({ key: 'PAY-42' }) });
    const result = await createJiraIssue(event, {
      baseUrl: 'https://x.atlassian.net',
      token: 'abc',
      fetchImpl,
    });
    expect(result).toEqual({ key: 'PAY-42' });
    expect(fetchImpl).toHaveBeenNthCalledWith(1, 'https://x.atlassian.net/_edge/tenant_info');
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/issue',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer abc' }),
      }),
    );
  });

  it('falls back to classic Basic auth against the site when no cloud ID resolves', async () => {
    const fetchImpl = jest
      .fn()
      // resolveCloudId fails
      .mockResolvedValueOnce({ ok: false })
      // postIssue against the site directly
      .mockResolvedValueOnce({ ok: true, json: async () => ({ key: 'PAY-43' }) });
    const result = await createJiraIssue(event, {
      baseUrl: 'https://x.atlassian.net',
      token: 'abc',
      fetchImpl,
    });
    expect(result).toEqual({ key: 'PAY-43' });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://x.atlassian.net/rest/api/3/issue',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Basic abc' }),
      }),
    );
  });

  it('returns null when both the gateway and the classic fallback reject the request', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ cloudId: 'cloud-1' }) })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: false });
    const result = await createJiraIssue(event, {
      baseUrl: 'https://x.atlassian.net',
      token: 'abc',
      fetchImpl,
    });
    expect(result).toBeNull();
  });
});
