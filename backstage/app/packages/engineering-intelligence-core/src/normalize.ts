// Normalisers map a raw metric, in its own units, onto the 0–100 scale the
// scoring engine works in. They are the only place a judgement like "an hour of
// lead time is good" is expressed, so they are pure, exhaustively typed, and
// unit-tested at their boundaries.

/** Clamp to the 0–100 range every normaliser promises to return. */
export function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

export type Normaliser =
  /** Higher is better; `min` scores 0, `max` scores 100. */
  | { kind: 'linear'; min: number; max: number }
  /** Lower is better; `min` scores 100, `max` scores 0. */
  | { kind: 'inverseLinear'; min: number; max: number }
  /** A 0–1 ratio, scored directly as a percentage. */
  | { kind: 'ratio' }
  /**
   * Ordered bands, DORA-style. Each band names the upper bound of the raw value
   * it covers and the score awarded. Bands must be sorted by ascending `upTo`;
   * anything above the last band scores `below`.
   */
  | { kind: 'banded'; bands: { upTo: number; score: number }[]; below: number };

export function normalise(raw: number, spec: Normaliser): number {
  switch (spec.kind) {
    case 'linear': {
      if (spec.max === spec.min) return clamp(raw >= spec.max ? 100 : 0);
      return clamp(((raw - spec.min) / (spec.max - spec.min)) * 100);
    }
    case 'inverseLinear': {
      if (spec.max === spec.min) return clamp(raw <= spec.min ? 100 : 0);
      return clamp(((spec.max - raw) / (spec.max - spec.min)) * 100);
    }
    case 'ratio':
      return clamp(raw * 100);
    case 'banded': {
      for (const band of spec.bands) {
        if (raw <= band.upTo) return clamp(band.score);
      }
      return clamp(spec.below);
    }
    default: {
      // Exhaustiveness guard: adding a normaliser kind without handling it here
      // becomes a compile error rather than a silent zero at runtime.
      const unreachable: never = spec;
      throw new Error(
        `unknown normaliser: ${JSON.stringify(unreachable as unknown)}`,
      );
    }
  }
}

// Shared band sets, so the DORA thresholds are stated once.
// Values follow the elite/high/medium/low bands already documented for the DORA
// entity tab in docs/dora-finops.md.

/** Deploys per day. Elite ≥ 1/day. Higher is better, so bands run downward. */
export const DEPLOY_FREQUENCY_BANDS: Normaliser = {
  kind: 'banded',
  // `upTo` bands are ascending, so express "higher is better" by inverting:
  // anything at or below 0.03/day (about monthly) is Low, and so on upward.
  bands: [
    { upTo: 0.03, score: 25 },
    { upTo: 0.14, score: 50 },
    { upTo: 1, score: 75 },
  ],
  below: 100,
};

/** Median commit-to-deploy, in minutes. Elite < 60. */
export const LEAD_TIME_BANDS: Normaliser = {
  kind: 'banded',
  bands: [
    { upTo: 60, score: 100 },
    { upTo: 60 * 24, score: 75 },
    { upTo: 60 * 24 * 7, score: 50 },
  ],
  below: 25,
};

/** Mean time to restore, in minutes. Elite < 60. */
export const MTTR_BANDS: Normaliser = {
  kind: 'banded',
  bands: [
    { upTo: 60, score: 100 },
    { upTo: 60 * 24, score: 75 },
    { upTo: 60 * 24 * 7, score: 50 },
  ],
  below: 25,
};

/** Change failure rate, as a percentage. Elite < 5%. */
export const CHANGE_FAILURE_BANDS: Normaliser = {
  kind: 'banded',
  bands: [
    { upTo: 5, score: 100 },
    { upTo: 10, score: 75 },
    { upTo: 15, score: 50 },
  ],
  below: 25,
};
