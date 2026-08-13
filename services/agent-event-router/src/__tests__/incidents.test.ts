import {
  GitHubIncidentStore,
  MemoryIncidentStore,
  correlatePagerDuty,
  parseMarker,
  renderMarker,
  toPriority,
  upsertMarker,
} from '../incidents';

const res = (ok: boolean, json: unknown) =>
  ({ ok, status: ok ? 200 : 500, json: async () => json }) as unknown as Response;

describe('severity taxonomy', () => {
  it('maps the Prometheus vocabulary onto P1/P2/P3', () => {
    expect(toPriority('critical')).toBe('P1');
    expect(toPriority('warning')).toBe('P2');
    expect(toPriority('info')).toBe('P3');
  });

  it('is case-insensitive and defaults unknown severities to P3', () => {
    expect(toPriority('CRITICAL')).toBe('P1');
    expect(toPriority('bogus')).toBe('P3');
    expect(toPriority('')).toBe('P3');
  });
});

describe('incident marker', () => {
  const marker = {
    v: 1 as const,
    fingerprint: 'fp1',
    incidentId: 'INC-20260814',
    severity: 'P1' as const,
    rawSeverity: 'critical',
    service: 'checkout',
    startsAt: '2026-08-14T10:00:00Z',
  };

  it('round-trips through an issue body', () => {
    const body = `## Incident\n\n${renderMarker(marker)}`;
    expect(parseMarker(body)).toEqual(marker);
  });

  it('returns null rather than throwing on a hand-mangled marker', () => {
    expect(parseMarker('<!-- idp-incident: {not json} -->')).toBeNull();
    expect(parseMarker('no marker here')).toBeNull();
    expect(parseMarker(undefined)).toBeNull();
  });

  it('replaces an existing marker rather than appending a second', () => {
    const body = `text\n\n${renderMarker(marker)}`;
    const updated = upsertMarker(body, { ...marker, endsAt: '2026-08-14T11:00:00Z' });
    expect(updated.match(/idp-incident/g)).toHaveLength(1);
    expect(parseMarker(updated)?.endsAt).toBe('2026-08-14T11:00:00Z');
  });
});

describe('GitHubIncidentStore', () => {
  const config = { token: 't', repo: 'org/repo' };

  it('rehydrates open incidents from GitHub so a restart does not re-file', async () => {
    const marker = renderMarker({
      v: 1,
      fingerprint: 'fp1',
      incidentId: 'INC-1',
      severity: 'P1',
      rawSeverity: 'critical',
      service: 'checkout',
      startsAt: '2026-08-14T10:00:00Z',
    });
    const fetchImpl = jest.fn().mockResolvedValue(res(true, [{ number: 42, body: `x\n${marker}` }]));
    const store = new GitHubIncidentStore({ ...config, fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(await store.rehydrate()).toBe(1);
    // Served from cache — no second call.
    expect(await store.get('fp1')).toEqual({
      issueNumber: 42,
      alertname: 'INC-1',
      startsAt: '2026-08-14T10:00:00Z',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('skips issues with no marker rather than failing the whole rehydrate', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(res(true, [{ number: 7, body: 'legacy issue' }]));
    const store = new GitHubIncidentStore({ ...config, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await store.rehydrate()).toBe(0);
  });

  it('falls through to GitHub search on a cache miss', async () => {
    const marker = renderMarker({
      v: 1,
      fingerprint: 'fp9',
      incidentId: 'INC-9',
      severity: 'P1',
      rawSeverity: 'critical',
      service: 'api',
      startsAt: '2026-08-14T10:00:00Z',
    });
    const fetchImpl = jest.fn().mockResolvedValue(res(true, { items: [{ number: 9, body: marker }] }));
    const store = new GitHubIncidentStore({ ...config, fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(await store.get('fp9')).toEqual({
      issueNumber: 9,
      alertname: 'INC-9',
      startsAt: '2026-08-14T10:00:00Z',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('treats a search outage as not-found, preferring a duplicate over a dropped incident', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('network down'));
    const store = new GitHubIncidentStore({ ...config, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await store.get('fp1')).toBeUndefined();
  });
});

describe('correlatePagerDuty', () => {
  const base = { alertname: 'DiskFull', service: 'checkout', startsAt: '2026-08-14T10:00:00Z' };

  it('links when exactly one incident matches both alertname and service', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      res(true, { incidents: [{ id: 'PD1', html_url: 'https://pd/PD1', title: 'DiskFull on checkout' }] }),
    );
    const out = await correlatePagerDuty(base, {
      token: 't',
      serviceIds: ['S1'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out).toEqual({ id: 'PD1', url: 'https://pd/PD1' });
  });

  it('refuses to guess when two incidents match', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      res(true, {
        incidents: [
          { id: 'PD1', html_url: 'https://pd/PD1', title: 'DiskFull on checkout' },
          { id: 'PD2', html_url: 'https://pd/PD2', title: 'DiskFull on checkout too' },
        ],
      }),
    );
    expect(
      await correlatePagerDuty(base, {
        token: 't',
        serviceIds: ['S1'],
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).toBeNull();
  });

  it('requires the service to match, not just the alertname', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      res(true, { incidents: [{ id: 'PD1', html_url: 'https://pd/PD1', title: 'DiskFull on payments' }] }),
    );
    expect(
      await correlatePagerDuty(base, {
        token: 't',
        serviceIds: ['S1'],
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).toBeNull();
  });

  it('is a no-op without a token or service ids', async () => {
    expect(await correlatePagerDuty(base, { token: '', serviceIds: ['S1'] })).toBeNull();
    expect(await correlatePagerDuty(base, { token: 't', serviceIds: [] })).toBeNull();
  });
});

describe('MemoryIncidentStore', () => {
  it('dedupes within a process but recovers nothing across a restart', async () => {
    const store = new MemoryIncidentStore();
    store.put('fp1', { issueNumber: 1, alertname: 'A', startsAt: 's' });
    expect(await store.get('fp1')).toBeDefined();
    expect(await new MemoryIncidentStore().rehydrate()).toBe(0);
  });
});
