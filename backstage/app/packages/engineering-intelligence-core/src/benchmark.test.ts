// The failure this file prevents: something leaving the platform that nobody
// agreed to send.
//
// Phase 11 is deliberately data-model-only, so the tests here are mostly about
// what is *absent*. The submission shape is the whole contract — if a reviewer
// can read `toSubmission` and see seven numbers, the claim that benchmarking
// transmits nothing identifying is checkable rather than a promise in a comment.

import {
  MIN_COHORT_SIZE,
  NO_BENCHMARK_PROVIDER,
  placeOrWithhold,
  toSubmission,
} from './benchmark';
import { MetricSample } from './model';
import { scoreHealth } from './score';
import {
  DEFAULT_ORGANISATION,
  defaultScope,
  isSingleTenant,
  scopeFrom,
  scopeKey,
} from './tenancy';

const OBSERVED = '2026-08-29T09:00:00.000Z';

function sample(
  metric: string,
  value: number,
  source = 'prometheus',
): MetricSample {
  return { metric, value, source, observedAt: OBSERVED };
}

const REPORT = scoreHealth(
  [
    sample('catalog.ownershipCoverage', 1, 'catalog'),
    sample('catalog.goldenPathAdoption', 0.5, 'catalog'),
    sample('dora.changeFailureRatePercent', 4),
    sample('dora.mttrMinutes', 30),
  ],
  { generatedAt: OBSERVED },
);

describe('toSubmission', () => {
  it('sends scores and a maturity level, and nothing else', () => {
    // The entire contract, assertable by reading one object.
    const submission = toSubmission(REPORT);
    expect(Object.keys(submission).sort()).toEqual([
      'capturedOn',
      'maturityLevel',
      'schemaVersion',
      'scores',
    ]);
  });

  it('carries no names, evidence or sources', () => {
    // Serialise and search, rather than trusting the type: an added field would
    // be caught here even if nobody updated the interface's doc comment.
    const serialised = JSON.stringify(toSubmission(REPORT));
    expect(serialised).not.toContain('catalog');
    expect(serialised).not.toContain('prometheus');
    expect(serialised).not.toContain('evidence');
    expect(serialised).not.toContain('recommendation');
  });

  it('reduces the timestamp to a day', () => {
    // An exact timestamp is a correlation key across submissions — it would let
    // a recipient link two "anonymous" payloads to the same installation.
    expect(toSubmission(REPORT).capturedOn).toBe('2026-08-29');
    expect(toSubmission(REPORT).capturedOn).not.toContain('T');
  });

  it('omits an unscored dimension rather than sending zero', () => {
    // A cohort averaging those zeros would conclude the industry is worse at
    // Developer Experience than it is, purely because nobody measures it.
    const submission = toSubmission(REPORT);
    expect(submission.scores.devEx).toBeUndefined();
    expect(submission.scores.platform).toBeDefined();
  });
});

describe('the anonymity floor', () => {
  it('withholds a placement drawn from too small a cohort', () => {
    // In a cohort of three, "you are 33rd percentile" tells the other two
    // exactly where everyone sits.
    const placed = placeOrWithhold([
      { dimension: 'platform', score: 70, percentile: 33, cohortSize: 3 },
      { dimension: 'quality', score: 80, percentile: 61, cohortSize: 50 },
    ]);

    expect(placed[0].percentile).toBeNull();
    expect(placed[1].percentile).toBe(61);
  });

  it('enforces the floor in this package, not in each provider', () => {
    const placed = placeOrWithhold([
      {
        dimension: 'platform',
        score: 70,
        percentile: 90,
        cohortSize: MIN_COHORT_SIZE - 1,
      },
    ]);
    expect(placed[0].percentile).toBeNull();
  });
});

describe('the default provider', () => {
  it('exists, does nothing, and names itself as doing nothing', () => {
    // "Benchmarking is off" is a state with a name rather than a null check
    // repeated at every call site.
    expect(NO_BENCHMARK_PROVIDER.name).toBe('none');
  });

  it('returns an empty result rather than throwing', async () => {
    const result = await NO_BENCHMARK_PROVIDER.compare(toSubmission(REPORT));
    expect(result.percentiles).toEqual([]);
    expect(result.cohort).toBe('none');
  });
});

// ── tenancy (phase 12) ────────────────────────────────────────────────────────

describe('tenancy', () => {
  it('treats single-tenant as the one-organisation case, not a special path', () => {
    // DEFAULT_ORGANISATION is a real id rather than a null, so a row written
    // today needs no migration if a second organisation ever appears.
    expect(defaultScope()).toEqual({ organisationId: DEFAULT_ORGANISATION });
    expect(isSingleTenant(defaultScope())).toBe(true);
  });

  it('stops being single-tenant as soon as any narrowing is applied', () => {
    expect(
      isSingleTenant({ organisationId: DEFAULT_ORGANISATION, teamId: 'a' }),
    ).toBe(false);
    expect(isSingleTenant({ organisationId: 'acme' })).toBe(false);
  });

  it('builds keys that sort into the hierarchy and omit unset levels', () => {
    // A key containing a literal "undefined" works until someone reads the table.
    expect(scopeKey(defaultScope())).toBe('default');
    expect(scopeKey({ organisationId: 'acme', teamId: 'payments' })).toBe(
      'acme/payments',
    );
    expect(
      scopeKey({
        organisationId: 'acme',
        teamId: 'payments',
        serviceRef: 'orders',
      }),
    ).toBe('acme/payments/orders');
    expect(
      scopeKey({ organisationId: 'acme', serviceRef: 'orders' }),
    ).not.toContain('undefined');
  });

  it('ignores a stray scope parameter instead of erroring', () => {
    // On a single-tenant install a leftover query parameter should do nothing,
    // not produce an error page.
    expect(scopeFrom({})).toEqual({
      organisationId: DEFAULT_ORGANISATION,
      teamId: undefined,
      serviceRef: undefined,
    });
    expect(scopeFrom({ organisationId: 42 }).organisationId).toBe(
      DEFAULT_ORGANISATION,
    );
    expect(scopeFrom({ organisationId: '  ' }).organisationId).toBe(
      DEFAULT_ORGANISATION,
    );
  });

  it('reads a real scope when one is given', () => {
    expect(scopeFrom({ organisationId: 'acme', teamId: 'payments' })).toEqual({
      organisationId: 'acme',
      teamId: 'payments',
      serviceRef: undefined,
    });
  });
});
