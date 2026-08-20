import { firstMatch } from './pick';

describe('firstMatch', () => {
  it('returns the value for the first true condition', () => {
    expect(firstMatch([[false, 'a'], [true, 'b'], [true, 'c']], 'z')).toBe('b');
  });

  it('returns the fallback when nothing matches', () => {
    expect(firstMatch([[false, 'a'], [false, 'b']], 'z')).toBe('z');
  });

  it('returns the fallback for an empty band list', () => {
    expect(firstMatch([], 'z')).toBe('z');
  });

  it('preserves order, which is what makes it a drop-in for an else-if chain', () => {
    // Descending thresholds: 150 must pick the >=100 band, not the >=80 one.
    const band = (pct: number) =>
      firstMatch([[pct >= 100, 'over'], [pct >= 80, 'near']], 'under');
    expect(band(150)).toBe('over');
    expect(band(100)).toBe('over');
    expect(band(80)).toBe('near');
    expect(band(79)).toBe('under');
  });

  it('matches the ternary chain it replaced, including the null case', () => {
    // The original was: pct == null ? grey : pct >= 100 ? red : pct >= 80 ? amber : green
    const colorOld = (pct: number | null) =>
      // eslint-disable-next-line no-nested-ternary
      pct == null ? 'grey' : pct >= 100 ? 'red' : pct >= 80 ? 'amber' : 'green';
    const colorNew = (pct: number | null) =>
      firstMatch([
        [pct == null, 'grey'],
        [pct != null && pct >= 100, 'red'],
        [pct != null && pct >= 80, 'amber'],
      ], 'green');
    for (const v of [null, 0, 79, 80, 99, 100, 101, -5]) {
      expect(colorNew(v)).toBe(colorOld(v));
    }
  });
});
