// Normalisers are the only place a raw metric becomes a judgement, so their
// boundaries are what a wrong score would come from. These lock down the two
// mistakes that are easy to make here: an inverted scale (lower-is-better
// scored as higher-is-better) and an unclamped value escaping the 0–100 range
// and silently skewing every dimension it contributes to.

import {
  CHANGE_FAILURE_BANDS,
  DEPLOY_FREQUENCY_BANDS,
  LEAD_TIME_BANDS,
  MTTR_BANDS,
  clamp,
  normalise,
} from './normalize';

describe('clamp', () => {
  it('holds the 0–100 range', () => {
    expect(clamp(-20)).toBe(0);
    expect(clamp(0)).toBe(0);
    expect(clamp(55)).toBe(55);
    expect(clamp(100)).toBe(100);
    expect(clamp(140)).toBe(100);
  });

  it('maps non-finite values to 0 rather than propagating NaN', () => {
    expect(clamp(NaN)).toBe(0);
    expect(clamp(Infinity)).toBe(0);
    expect(clamp(-Infinity)).toBe(0);
  });
});

describe('linear', () => {
  const spec = { kind: 'linear', min: 0, max: 10 } as const;

  it('scores the endpoints and midpoint', () => {
    expect(normalise(0, spec)).toBe(0);
    expect(normalise(5, spec)).toBe(50);
    expect(normalise(10, spec)).toBe(100);
  });

  it('clamps outside the range', () => {
    expect(normalise(-3, spec)).toBe(0);
    expect(normalise(99, spec)).toBe(100);
  });

  it('does not divide by zero when min equals max', () => {
    const degenerate = { kind: 'linear', min: 5, max: 5 } as const;
    expect(normalise(5, degenerate)).toBe(100);
    expect(normalise(4, degenerate)).toBe(0);
  });
});

describe('inverseLinear', () => {
  const spec = { kind: 'inverseLinear', min: 10, max: 60 } as const;

  it('scores lower raw values higher', () => {
    expect(normalise(10, spec)).toBe(100);
    expect(normalise(35, spec)).toBe(50);
    expect(normalise(60, spec)).toBe(0);
  });

  it('clamps below min and above max', () => {
    expect(normalise(0, spec)).toBe(100);
    expect(normalise(1000, spec)).toBe(0);
  });

  it('does not divide by zero when min equals max', () => {
    const degenerate = { kind: 'inverseLinear', min: 5, max: 5 } as const;
    expect(normalise(5, degenerate)).toBe(100);
    expect(normalise(6, degenerate)).toBe(0);
  });
});

describe('ratio', () => {
  it('reads a 0–1 ratio as a percentage', () => {
    expect(normalise(0, { kind: 'ratio' })).toBe(0);
    expect(normalise(0.74, { kind: 'ratio' })).toBeCloseTo(74);
    expect(normalise(1, { kind: 'ratio' })).toBe(100);
  });

  it('clamps a ratio above 1 — budget utilisation can exceed the budget', () => {
    expect(normalise(1.4, { kind: 'ratio' })).toBe(100);
  });
});

describe('banded', () => {
  it('picks the first band whose upper bound the value falls within', () => {
    // Lead time in minutes: under an hour is elite, under a day is high.
    expect(normalise(30, LEAD_TIME_BANDS)).toBe(100);
    expect(normalise(60, LEAD_TIME_BANDS)).toBe(100);
    expect(normalise(61, LEAD_TIME_BANDS)).toBe(75);
    expect(normalise(60 * 24 * 30, LEAD_TIME_BANDS)).toBe(25);
  });

  it('scores change failure rate against the documented elite threshold', () => {
    expect(normalise(2, CHANGE_FAILURE_BANDS)).toBe(100);
    expect(normalise(5, CHANGE_FAILURE_BANDS)).toBe(100);
    expect(normalise(7, CHANGE_FAILURE_BANDS)).toBe(75);
    expect(normalise(40, CHANGE_FAILURE_BANDS)).toBe(25);
  });

  it('scores MTTR the same way as lead time', () => {
    expect(normalise(45, MTTR_BANDS)).toBe(100);
    expect(normalise(60 * 48, MTTR_BANDS)).toBe(50);
  });

  it('runs deploy frequency upward — more deploys score higher', () => {
    // The one band set where a larger raw value is better; a sign error here
    // would rank a monthly-deploy platform as elite.
    expect(normalise(0.01, DEPLOY_FREQUENCY_BANDS)).toBe(25);
    expect(normalise(0.1, DEPLOY_FREQUENCY_BANDS)).toBe(50);
    expect(normalise(0.5, DEPLOY_FREQUENCY_BANDS)).toBe(75);
    expect(normalise(3, DEPLOY_FREQUENCY_BANDS)).toBe(100);
  });
});
