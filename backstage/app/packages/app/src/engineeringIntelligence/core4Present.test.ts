import {
  changeLabel,
  cycleStatus,
  formatCore4Value,
  formatKeyMetric,
  teamCell,
} from './core4Present';

describe('formatKeyMetric', () => {
  it('formats each key metric in its own units', () => {
    expect(formatKeyMetric('core4.diffsPerEngineerWeekly', 2.83)).toBe('2.8 PRs / engineer / week');
    expect(formatKeyMetric('survey.dxi', 71.6)).toBe('72 / 100');
    expect(formatKeyMetric('dora.changeFailureRatePercent', 8)).toBe('8.0% of deploys');
    expect(formatKeyMetric('survey.newCapabilitiesRatio', 0.45)).toBe('45% of time');
  });

  it('renders an unobserved key metric as a dash, never zero', () => {
    expect(formatKeyMetric('survey.dxi', null)).toBe('—');
    expect(formatKeyMetric('survey.dxi', undefined)).toBe('—');
  });
});

describe('formatCore4Value', () => {
  it('reads survey perceptions as scores, not ratios', () => {
    expect(formatCore4Value('survey.perceivedDeliveryRate', 62.4)).toBe('62 / 100');
  });

  it('defers to the health page formatter for system metrics', () => {
    expect(formatCore4Value('dora.leadTimeMinutes', 90)).toBe('1.5 hr');
    expect(formatCore4Value('security.scanningControlsRatio', 0.9)).toBe('90%');
  });
});

describe('changeLabel', () => {
  const change = { area: 'speed' as const, label: 'Speed', keyBefore: 2, keyNow: 3 };

  it('shows direction and size', () => {
    expect(changeLabel({ ...change, delta: 4.2 }, 91)).toBe('▲ +4.2 over 91 days');
    expect(changeLabel({ ...change, delta: -3 }, 91)).toBe('▼ -3 over 91 days');
  });

  it('says why there is no movement instead of showing zero', () => {
    expect(changeLabel(undefined, undefined)).toMatch(/No earlier quarter/);
    expect(changeLabel({ ...change, delta: null }, 91)).toMatch(/Not scored on both/);
  });
});

describe('teamCell', () => {
  const pct = (v: number) => `${Math.round(v * 100)}%`;

  it('distinguishes withheld from unmeasured', () => {
    expect(teamCell(0.4, pct, false)).toBe('40%');
    expect(teamCell(null, pct, true)).toBe('withheld');
    expect(teamCell(null, pct, false)).toBe('—');
  });
});

describe('cycleStatus', () => {
  const now = Date.parse('2026-10-17T12:00:00.000Z');

  it('counts down an open cycle and up from a closed one', () => {
    expect(cycleStatus({ closesAt: '2026-10-24T12:00:00.000Z', open: true }, now)).toBe('closes in 7 days');
    expect(cycleStatus({ closesAt: '2026-10-16T12:00:00.000Z', open: false }, now)).toBe('closed 1 day ago');
  });
});
