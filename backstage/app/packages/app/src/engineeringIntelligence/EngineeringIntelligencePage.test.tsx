// Renders the page against a stubbed API to pin the three things that would do
// real damage if they regressed:
//
//   1. An unscored dimension showing a number.
//   2. A failed request rendering as a healthy-looking score.
//   3. Evidence gaps presented as risks — "we cannot measure this" is a gap in
//      instrumentation, not a finding about the engineering organisation.
//
// The repo's frontend test convention is plain @testing-library/react rather
// than renderInTestApp (see App.test.tsx), so the two Backstage APIs the page
// uses are stubbed directly.

import { render, screen, waitFor } from '@testing-library/react';
import type { HealthResponse } from './api';

const fetchMock = jest.fn();

// The stubs must be stable across renders, because the real useApi returns a
// singleton. Handing back a fresh object each call invalidates the page's
// useMemo, which re-creates its client, which re-runs the load effect — an
// endless refetch that exists only in the test harness.
const fetchApiStub = { fetch: (...args: any[]) => fetchMock(...args) };
const configApiStub = { getString: () => 'http://backstage' };

jest.mock('@backstage/core-plugin-api', () => ({
  useApi: (ref: any) => (ref === 'config' ? configApiStub : fetchApiStub),
  fetchApiRef: 'fetch',
  configApiRef: 'config',
}));

// The real components render a full Backstage page shell; the page's own markup
// is what is under test here.
jest.mock('@backstage/core-components', () => ({
  Page: ({ children }: any) => <div>{children}</div>,
  Header: ({ title }: any) => <h1>{title}</h1>,
  Content: ({ children }: any) => <div>{children}</div>,
  Progress: () => <div>loading</div>,
}));

// eslint-disable-next-line import/first
import { EngineeringIntelligencePage } from './EngineeringIntelligencePage';

function dimension(id: string, score: number | null, extra: any = {}) {
  return {
    dimension: id,
    score,
    status: score === null ? 'insufficient-evidence' : 'ok',
    coverage: score === null ? 0.25 : 1,
    evidence: [],
    missing: [],
    ...extra,
  };
}

const REPORT: HealthResponse = {
  generatedAt: new Date().toISOString(),
  overallScore: 82,
  status: 'partial',
  dimensions: {
    platform: dimension('platform', 75),
    devEx: dimension('devEx', null, {
      missing: [
        { metric: 'devex.prCycleTimeHours', expectedFrom: 'github', reason: 'x' },
      ],
    }),
    quality: dimension('quality', 89.1),
    reliability: dimension('reliability', 100),
    aiEngineering: dimension('aiEngineering', null),
    security: dimension('security', null),
    finops: dimension('finops', 63.8),
  },
  recommendations: [
    {
      id: 'catalog.goldenPathAdoption',
      dimension: 'platform',
      severity: 'warning',
      title: 'Services scaffolded from a golden-path template is below target',
      action: 'Move services onto an approved golden-path template.',
      evidence: [
        {
          metric: 'catalog.goldenPathAdoption',
          value: 0.5,
          normalised: 50,
          source: 'catalog',
          observedAt: new Date().toISOString(),
          impact: 15,
        },
      ],
    },
  ],
  maturity: {
    currentLevel: 3,
    currentLevelName: 'Platform Enabled',
    confirmed: false,
    summary: 'Level 3 — Platform Enabled (unconfirmed above 3)',
    targetLevel: 4,
    gap: [],
    recommendedActions: [],
    levels: [
      { level: 1, name: 'Ad Hoc', description: '', status: 'met', requirements: [] },
      { level: 2, name: 'Standardised', description: '', status: 'met', requirements: [] },
      { level: 3, name: 'Platform Enabled', description: '', status: 'met', requirements: [] },
      { level: 4, name: 'AI Enabled', description: '', status: 'unconfirmed', requirements: [] },
      {
        level: 5,
        name: 'Autonomous Engineering',
        description: '',
        status: 'unconfirmed',
        requirements: [],
      },
    ],
  },
  evidenceGaps: [
    {
      dimension: 'devEx',
      missing: ['devex.prCycleTimeHours'],
      expectedFrom: ['github (not yet collected — phase 5)'],
    },
  ],
} as unknown as HealthResponse;

function respond(body: unknown, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: async () => body } as Response);
}

const PLATFORM = {
  generatedAt: new Date().toISOString(),
  available: true,
  services: 5,
  owned: 4,
  scaffolded: 2,
  ownershipCoverage: 0.8,
  goldenPathAdoption: 0.4,
  templateUsage: [{ template: 'go-service', count: 2 }],
  notOnGoldenPath: {
    count: 3,
    named: ['adhoc-tool', 'legacy-cron', 'orphaned-tool'],
    truncated: false,
  },
  selfService: { completed: 9, failed: 1, inFlight: 0 },
  platformScore: 75,
};

const READINESS = {
  generatedAt: new Date().toISOString(),
  overallScore: 71,
  status: 'partial',
  measurable: 2,
  total: 3,
  areas: {
    governance: { dimension: 'governance', score: 90, status: 'ok', coverage: 1, evidence: [], missing: [] },
    evaluation: { dimension: 'evaluation', score: 52, status: 'ok', coverage: 1, evidence: [], missing: [] },
    privacy: {
      dimension: 'privacy',
      score: null,
      status: 'insufficient-evidence',
      coverage: 0,
      evidence: [],
      missing: [
        { metric: 'ai.piiLeakageTested', expectedFrom: 'not collected — needs a PII evaluation (phase 7)', reason: 'x' },
      ],
    },
  },
};

/** Route the page's GETs; `health` decides success or failure. */
function routes(health: unknown, ok = true, status = 200) {
  return (url: string) => {
    if (url.includes('/snapshots')) return respond({ snapshots: [] });
    if (url.includes('/ai-readiness')) return respond(READINESS);
    if (url.includes('/platform')) return respond(PLATFORM);
    return respond(health, ok, status);
  };
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('EngineeringIntelligencePage', () => {
  it('shows the overall score and the maturity level', async () => {
    fetchMock.mockImplementation(routes(REPORT));

    render(<EngineeringIntelligencePage />);

    await waitFor(() => expect(screen.getByText('82')).toBeInTheDocument());
    // Twice on purpose: once in the headline, once as the current rung of the
    // maturity ladder.
    expect(screen.getAllByText(/Level 3 — Platform Enabled/)).toHaveLength(2);
    expect(screen.getByText(/cannot be assessed/)).toBeInTheDocument();
  });

  it('renders an unscored dimension as a dash and names the source it needs', async () => {
    fetchMock.mockImplementation(routes(REPORT));

    render(<EngineeringIntelligencePage />);

    await waitFor(() => expect(screen.getByText('82')).toBeInTheDocument());

    // Three dimensions are unscored, so at least three dashes — never a 0.
    // Counted with `>=` rather than exactly: the AI readiness card renders its
    // own unmeasurable areas as dashes on the same page, and pinning an exact
    // total would fail for a correct change while testing nothing extra.
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3);
    expect(screen.queryByText('0')).not.toBeInTheDocument();
    expect(
      screen.getAllByText(/Insufficient evidence — needs github/).length,
    ).toBeGreaterThan(0);
  });

  it('says there is no trend rather than reporting no change', async () => {
    fetchMock.mockImplementation(routes(REPORT));

    render(<EngineeringIntelligencePage />);

    await waitFor(() =>
      expect(screen.getByText(/No trend yet/)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/▲ 0/)).not.toBeInTheDocument();
  });

  it('keeps evidence gaps out of the risk list', async () => {
    fetchMock.mockImplementation(routes(REPORT));

    render(<EngineeringIntelligencePage />);

    await waitFor(() => expect(screen.getByText('Top risks')).toBeInTheDocument());

    // The one real recommendation appears as a risk...
    expect(screen.getByText(/golden-path template is below target/)).toBeInTheDocument();
    // ...and the unmeasurable dimension appears in its own section instead.
    expect(screen.getByText('Cannot measure yet')).toBeInTheDocument();
    expect(
      screen.getByText(/needs github \(not yet collected — phase 5\)/),
    ).toBeInTheDocument();
  });

  it('renders the Platform Health breakdown and names the services off the golden path', async () => {
    // "42 services are not on a golden path" is a statistic; naming them is what
    // a platform team can act on.
    fetchMock.mockImplementation(routes(REPORT));

    render(<EngineeringIntelligencePage />);

    await waitFor(() => expect(screen.getByText('Platform Health')).toBeInTheDocument());
    expect(screen.getByText('Services')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText(/services are not using an approved golden path/)).toBeInTheDocument();
    expect(screen.getByText(/adhoc-tool, legacy-cron, orphaned-tool/)).toBeInTheDocument();
    expect(screen.getByText(/go-service \(2\)/)).toBeInTheDocument();
  });

  it('shows a dash for self-service before any scaffolder task has finished', async () => {
    // 0% would say the scaffolder is broken; 100% would say it is proven.
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/snapshots')) return respond({ snapshots: [] });
      if (url.includes('/ai-readiness')) return respond(READINESS);
      if (url.includes('/platform')) {
        return respond({ ...PLATFORM, selfService: { completed: 0, failed: 0, inFlight: 2 } });
      }
      return respond(REPORT);
    });

    render(<EngineeringIntelligencePage />);

    await waitFor(() => expect(screen.getByText('Platform Health')).toBeInTheDocument());
    expect(screen.getByText(/no scaffolder task has finished yet/)).toBeInTheDocument();
  });

  it('still renders the report when the platform breakdown is unavailable', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/snapshots')) return respond({ snapshots: [] });
      if (url.includes('/ai-readiness')) return respond(READINESS);
      if (url.includes('/platform')) return respond({}, false, 500);
      return respond(REPORT);
    });

    render(<EngineeringIntelligencePage />);

    await waitFor(() => expect(screen.getByText('82')).toBeInTheDocument());
    expect(screen.queryByText('Platform Health')).not.toBeInTheDocument();
  });

  it('renders AI readiness and names the source an unmeasurable area needs', async () => {
    fetchMock.mockImplementation(routes(REPORT));

    render(<EngineeringIntelligencePage />);

    await waitFor(() =>
      expect(screen.getByText('AI Engineering Readiness')).toBeInTheDocument(),
    );
    expect(screen.getByText('71')).toBeInTheDocument();
    // The count is stated so a reader knows the score covers only part of the model.
    expect(screen.getByText(/2 of 3 areas measurable/)).toBeInTheDocument();
    // An unmeasurable area shows a dash plus what it is waiting on.
    expect(screen.getByText(/needs a PII evaluation/)).toBeInTheDocument();
  });

  it('shows an error instead of a score when the report cannot be loaded', async () => {
    // The failure this asserts: a 500 rendering as a plausible dashboard. Every
    // other page in this app falls back to demo data; this one must not.
    fetchMock.mockImplementation(() => respond({}, false, 500));

    render(<EngineeringIntelligencePage />);

    await waitFor(() =>
      expect(
        screen.getByText(/Could not load the Engineering Health report/),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText('82')).not.toBeInTheDocument();
    expect(screen.queryByText('Top risks')).not.toBeInTheDocument();
  });

  it('still renders the report when only the trend query fails', async () => {
    // The score is the point of the page; the sparkline is not.
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/snapshots')) return respond({}, false, 500);
      if (url.includes('/ai-readiness')) return respond(READINESS);
      if (url.includes('/platform')) return respond(PLATFORM);
      return respond(REPORT);
    });

    render(<EngineeringIntelligencePage />);

    await waitFor(() => expect(screen.getByText('82')).toBeInTheDocument());
    expect(screen.getByText(/No trend yet/)).toBeInTheDocument();
  });
});
