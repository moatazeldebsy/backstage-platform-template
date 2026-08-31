import { Entity } from '@backstage/catalog-model';
import {
  CHECKS,
  MOBILE_TIER_REQUIREMENTS,
  computeScorecard,
  isMobileEntity,
  lowerTier,
  missingMobileRequirement,
  mobileTier,
  visibleChecks,
} from './scorecard';

// A mobile entity that passes every mobile requirement. Individual tests strip
// annotations from this to check that the corresponding gate actually bites.
function mobileEntity(annotations: Record<string, string> = {}): Entity {
  return {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Component',
    metadata: {
      name: 'demo-app',
      tags: ['mobile', 'android'],
      annotations: {
        'backstage.io/mobile-min-sdk': '24',
        'backstage.io/crashlytics-enabled': 'true',
        'backstage.io/accessibility-tests': 'true',
        'backstage.io/app-size-budget-mb': '40',
        'backstage.io/code-signing-setup': 'true',
        ...annotations,
      },
    },
    spec: { type: 'mobile', owner: 'team-a' },
  } as Entity;
}

// Same as mobileEntity but tagged ios, so the iOS version scale applies.
function iosEntity(minSdk: string): Entity {
  const base = mobileEntity({ 'backstage.io/mobile-min-sdk': minSdk });
  return {
    ...base,
    metadata: { ...base.metadata, name: 'demo-ios-app', tags: ['mobile', 'ios'] },
  } as Entity;
}

const allMobilePassing = {
  'has-code-signing': true,
  'has-min-sdk-version': true,
  'has-accessibility-tests': true,
  'has-crashlytics-enabled': true,
  'has-app-size-budget': true,
} as any;

describe('isMobileEntity', () => {
  it('matches on spec.type', () => {
    expect(isMobileEntity({ spec: { type: 'mobile' }, metadata: {} } as any)).toBe(true);
  });

  it('matches on the mobile tag', () => {
    expect(isMobileEntity({ spec: { type: 'service' }, metadata: { tags: ['mobile'] } } as any)).toBe(true);
  });

  it('does not match an ordinary service', () => {
    expect(isMobileEntity({ spec: { type: 'service' }, metadata: { tags: ['go'] } } as any)).toBe(false);
  });

  it('is case-sensitive, matching the backend fact retriever', () => {
    // Not a friendliness bug: if this matched "Mobile" but the backend did not,
    // the entity page and the Grafana QA dashboard would score the same app
    // differently. Both sides are exact-match on purpose.
    expect(isMobileEntity({ spec: { type: 'Mobile' }, metadata: {} } as any)).toBe(false);
    expect(isMobileEntity({ spec: {}, metadata: { tags: ['Mobile'] } } as any)).toBe(false);
  });
});

describe('mobile tier requirements', () => {
  it('awards nothing without code signing, however much else passes', () => {
    const results = { ...allMobilePassing, 'has-code-signing': false };
    expect(mobileTier(results)).toBe('none');
  });

  it('awards bronze for code signing alone', () => {
    const results = {
      'has-code-signing': true,
      'has-min-sdk-version': false,
      'has-accessibility-tests': false,
      'has-crashlytics-enabled': false,
      'has-app-size-budget': false,
    } as any;
    expect(mobileTier(results)).toBe('bronze');
  });

  it('holds at bronze until both silver requirements are met', () => {
    const results = {
      ...allMobilePassing,
      'has-accessibility-tests': false,
      'has-crashlytics-enabled': false,
      'has-app-size-budget': false,
    } as any;
    expect(mobileTier(results)).toBe('bronze');
  });

  it('awards silver for signing + min-sdk + accessibility', () => {
    const results = {
      'has-code-signing': true,
      'has-min-sdk-version': true,
      'has-accessibility-tests': true,
      'has-crashlytics-enabled': false,
      'has-app-size-budget': false,
    } as any;
    expect(mobileTier(results)).toBe('silver');
  });

  it('awards gold only when all five pass', () => {
    expect(mobileTier(allMobilePassing)).toBe('gold');
    expect(mobileTier({ ...allMobilePassing, 'has-app-size-budget': false })).toBe('silver');
  });

  it('keeps each tier a superset of the one below', () => {
    const { bronze, silver, gold } = MOBILE_TIER_REQUIREMENTS;
    expect(silver).toEqual(expect.arrayContaining(bronze));
    expect(gold).toEqual(expect.arrayContaining(silver));
  });

  it('names the requirement blocking the next tier', () => {
    const results = {
      'has-code-signing': true,
      'has-min-sdk-version': false,
      'has-accessibility-tests': true,
      'has-crashlytics-enabled': true,
      'has-app-size-budget': true,
    } as any;
    expect(missingMobileRequirement('bronze', results)).toBe('has-min-sdk-version');
    expect(missingMobileRequirement('gold', allMobilePassing)).toBeNull();
  });
});

describe('minimum SDK floors', () => {
  it('accepts Android API 24 and rejects 23', () => {
    expect(computeScorecard(mobileEntity({ 'backstage.io/mobile-min-sdk': '24' })).results['has-min-sdk-version']).toBe(true);
    expect(computeScorecard(mobileEntity({ 'backstage.io/mobile-min-sdk': '23' })).results['has-min-sdk-version']).toBe(false);
  });

  it('uses the iOS scale for iOS-tagged entities', () => {
    // 16 is exactly the iOS floor, and well below the Android API-24 floor. The
    // ios tag is the only thing separating the two scales, so this pins that the
    // right one is chosen — an Android-scale comparison would reject it.
    const ios = iosEntity('16.0');
    expect(computeScorecard(ios).results['has-min-sdk-version']).toBe(true);
  });

  it('rejects an iOS version below the floor', () => {
    expect(computeScorecard(iosEntity('15.0')).results['has-min-sdk-version']).toBe(false);
  });

  it('does not apply the iOS floor to an Android app', () => {
    // 16 passes on the iOS scale but must fail on Android, where the floor is 24.
    expect(computeScorecard(mobileEntity({ 'backstage.io/mobile-min-sdk': '16' })).results['has-min-sdk-version']).toBe(false);
  });

  it('rejects a missing or unparseable value', () => {
    const e = mobileEntity();
    delete (e.metadata.annotations as any)['backstage.io/mobile-min-sdk'];
    expect(computeScorecard(e).results['has-min-sdk-version']).toBe(false);
    expect(computeScorecard(mobileEntity({ 'backstage.io/mobile-min-sdk': 'latest' })).results['has-min-sdk-version']).toBe(false);
  });
});

describe('annotations are exact-match, not truthy', () => {
  it.each(['false', 'yes', '1', ''])('treats %p as not enabled', value => {
    const r = computeScorecard(mobileEntity({ 'backstage.io/code-signing-setup': value })).results;
    expect(r['has-code-signing']).toBe(false);
  });
});

describe('visibleChecks', () => {
  it('hides mobile checks from non-mobile entities', () => {
    const ids = visibleChecks({ isAiEntity: false, isMobile: false }).map(c => c.id);
    expect(ids).not.toContain('has-code-signing');
  });

  it('shows mobile checks for mobile entities', () => {
    const ids = visibleChecks({ isAiEntity: false, isMobile: true }).map(c => c.id);
    expect(ids).toContain('has-code-signing');
  });

  it('keeps AI and mobile independent', () => {
    const ids = visibleChecks({ isAiEntity: false, isMobile: true }).map(c => c.id);
    expect(ids).not.toContain('has-model-card');
  });

  it('every visible check has a result key', () => {
    const score = computeScorecard(mobileEntity());
    for (const c of visibleChecks({ isAiEntity: false, isMobile: true })) {
      expect(score.results).toHaveProperty(c.id);
    }
  });
});

describe('mobile gates cap the count-based tier', () => {
  it('cannot exceed the mobile tier however many general checks pass', () => {
    // Strip code signing only: the general count is untouched, but the entity
    // must fall to "none" because Bronze requires it.
    const e = mobileEntity({ 'backstage.io/code-signing-setup': 'false' });
    expect(computeScorecard(e).tier).toBe('none');
  });

  it('does not raise a tier the general count has not earned', () => {
    // All mobile requirements pass (mobile tier = gold) but the entity has
    // almost no general checks, so the count model must still hold it down.
    expect(computeScorecard(mobileEntity()).tier).not.toBe('gold');
  });

  it('leaves non-mobile entities on the count model alone', () => {
    const svc = {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Component',
      metadata: { name: 'svc', annotations: {} },
      spec: { type: 'service' },
    } as Entity;
    expect(computeScorecard(svc).tier).toBe('none');
  });
});

describe('lowerTier', () => {
  it('returns the weaker of two tiers', () => {
    expect(lowerTier('gold', 'bronze')).toBe('bronze');
    expect(lowerTier('none', 'gold')).toBe('none');
    expect(lowerTier('silver', 'silver')).toBe('silver');
  });
});

describe('CHECKS integrity', () => {
  it('has unique ids', () => {
    const ids = CHECKS.map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every mobile requirement a definition and remediation', () => {
    for (const id of MOBILE_TIER_REQUIREMENTS.gold) {
      const def = CHECKS.find(c => c.id === id);
      expect(def).toBeDefined();
      expect(def!.group).toBe('Mobile');
      expect(def!.remediation).not.toHaveLength(0);
    }
  });
});

// ── drift guard: the scorecard exists twice ──────────────────────────────────
//
// The failure this prevents is the one that already happened. Tier logic lives
// here and again in observability/tech-insights-exporter/exporter.py, and the two
// disagree: this file scores 22 checks with gold at 9 (~41%), the exporter scores
// an 11-check subset with gold at 10 (~91%). A service can be gold on its entity
// page and bronze on the Grafana dashboard, and nothing said so.
//
// These tests do not assert the two agree — they do not, and reconciling them
// demotes live services, which is a decision for the scorecard owners rather than
// a quiet edit. They pin what each side does today, so the next change to either
// has to be deliberate instead of silent.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TIER_THRESHOLDS } from './scorecard';

function exporterSource(): string {
  return readFileSync(
    join(__dirname, '../../../../../observability/tech-insights-exporter/exporter.py'),
    'utf8',
  );
}

describe('scorecard drift between the UI and the exporter', () => {
  it('pins the check counts each implementation scores against', () => {
    const py = exporterSource();
    const block = py.slice(py.indexOf('HYGIENE_CHECKS'), py.indexOf('SCORECARD_CHECKS'));
    const exporterIds = [...block.matchAll(/"([a-z0-9-]+)"/g)].map(m => m[1]);

    expect(CHECKS).toHaveLength(22);
    expect(exporterIds).toHaveLength(11);
  });

  it('pins the gold thresholds, which disagree', () => {
    const py = exporterSource();
    const gold = /TIER_THRESHOLDS\s*=\s*\{[^}]*"gold":\s*(\d+)/.exec(py);
    expect(gold).not.toBeNull();

    expect(TIER_THRESHOLDS.gold).toBe(9);       // of 22 here — ~41%
    expect(Number(gold![1])).toBe(10);          // of 11 there — ~91%
  });

  it('keeps the exporter a strict subset, so its ids stay meaningful here', () => {
    // This is the one property worth enforcing rather than merely recording. The
    // exporter inventing a check id the UI does not know would make the two
    // scorecards incomparable, not merely differently calibrated.
    const py = exporterSource();
    const block = py.slice(py.indexOf('HYGIENE_CHECKS'), py.indexOf('SCORECARD_CHECKS'));
    const exporterIds = [...block.matchAll(/"([a-z0-9-]+)"/g)].map(m => m[1]);
    const uiIds = new Set(CHECKS.map(c => c.id as string));

    expect(exporterIds.filter(id => !uiIds.has(id))).toEqual([]);
  });
});
