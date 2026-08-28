// Guards the invariant the recommendation ids now rely on.
//
// A Recommendation is identified by its metric id alone, so the same metric
// declared in two dimensions would collide — two different findings sharing one
// id, with the phase-3 dashboard and the phase-9 advisor unable to tell them
// apart. Nothing else in the engine would notice.

import { DIMENSIONS } from './dimensions';

describe('DIMENSIONS', () => {
  it('declares each metric in exactly one dimension', () => {
    const seen = new Map<string, string>();
    for (const dimension of DIMENSIONS) {
      for (const signal of dimension.signals) {
        const existing = seen.get(signal.metric);
        expect(existing).toBeUndefined();
        seen.set(signal.metric, dimension.id);
      }
    }
  });

  it('gives every signal a positive weight', () => {
    // A zero-weight signal would collect and normalise, then contribute nothing
    // while still counting toward coverage — quietly propping up a dimension
    // that has not really been measured.
    for (const dimension of DIMENSIONS) {
      for (const signal of dimension.signals) {
        expect(signal.weight).toBeGreaterThan(0);
      }
    }
  });

  it('pairs every recommendBelow with recommendation text', () => {
    for (const dimension of DIMENSIONS) {
      for (const signal of dimension.signals) {
        if (signal.recommendBelow === undefined) continue;
        expect(signal.recommendation).toBeDefined();
        expect(signal.recommendation!.action.length).toBeGreaterThan(10);
      }
    }
  });

  it('keeps minCoverage a meaningful fraction', () => {
    for (const dimension of DIMENSIONS) {
      expect(dimension.minCoverage).toBeGreaterThan(0);
      expect(dimension.minCoverage).toBeLessThanOrEqual(1);
    }
  });
});
