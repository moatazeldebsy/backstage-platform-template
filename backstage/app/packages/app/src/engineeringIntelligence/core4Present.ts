import type { Core4Change } from '@internal/engineering-intelligence-core';
import { formatMetricValue } from './present';

// Pure presentation logic for the DX Core 4 page, kept out of the component for
// the reason given at the top of present.ts: it can be tested in milliseconds.
//
// The same contract as the rest of the dashboard: an absent value renders as a
// dash or "withheld", never as zero.

/** A key metric in the units leadership reads it in. */
export function formatKeyMetric(metric: string, value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  switch (metric) {
    case 'core4.diffsPerEngineerWeekly':
      return `${value.toFixed(1)} PRs / engineer / week`;
    case 'survey.dxi':
      return `${Math.round(value)} / 100`;
    case 'dora.changeFailureRatePercent':
      return `${value.toFixed(1)}% of deploys`;
    case 'survey.newCapabilitiesRatio':
      return `${Math.round(value * 100)}% of time`;
    default:
      return String(Math.round(value * 100) / 100);
  }
}

/**
 * A secondary metric's value. Survey perceptions are 0–100 scores, and the
 * health page's suffix rule would read `perceivedDeliveryRate` as a ratio.
 */
export function formatCore4Value(metric: string, value: number): string {
  if (metric.startsWith('survey.') && metric !== 'survey.newCapabilitiesRatio') {
    return `${Math.round(value)} / 100`;
  }
  return formatMetricValue(metric, value);
}

/** "▲ +4.2 since 91 days ago", or why there is no movement to show. */
export function changeLabel(change: Core4Change | undefined, sinceDays: number | undefined): string {
  if (!change || sinceDays === undefined) return 'No earlier quarter to compare with yet';
  if (change.delta === null) return 'Not scored on both dates';
  if (change.delta === 0) return `No change over ${sinceDays} days`;
  const arrow = change.delta > 0 ? '▲' : '▼';
  const sign = change.delta > 0 ? '+' : '';
  return `${arrow} ${sign}${change.delta} over ${sinceDays} days`;
}

/** A team-table cell: a value, a dash when unmeasured, "withheld" below the floor. */
export function teamCell(
  value: number | null,
  format: (v: number) => string,
  withheld: boolean,
): string {
  if (value !== null) return format(value);
  return withheld ? 'withheld' : '—';
}

/** Days until a cycle closes, or since it closed — for the survey banner. */
export function cycleStatus(
  cycle: { closesAt: string; open: boolean },
  now: number = Date.now(),
): string {
  const days = Math.round(Math.abs(Date.parse(cycle.closesAt) - now) / 86_400_000);
  if (cycle.open) return days <= 1 ? 'closes within a day' : `closes in ${days} days`;
  return days < 1 ? 'closed today' : `closed ${days} day${days === 1 ? '' : 's'} ago`;
}
