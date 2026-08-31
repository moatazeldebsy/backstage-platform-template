import type {
  DimensionId,
  DimensionScore,
  HealthReport,
  MaturityAssessment,
  Recommendation,
} from '@internal/engineering-intelligence-core';

// Pure presentation logic for the Engineering Intelligence dashboard.
//
// Split out from the page component for the reason stated at the top of
// scorecard.ts: importing a component into a test drags in the whole Backstage
// frontend and takes minutes, so the logic worth testing lives here instead.
//
// Nothing in this file invents a value. Where the report says a dimension has no
// score, every function here returns a placeholder — never a zero, never a
// plausible-looking number. That is the same contract the scoring engine keeps,
// and the dashboard is the surface where breaking it would matter most.

export interface SnapshotRow {
  capturedAt: string;
  overallScore: number | null;
  status: string;
  maturityLevel: number | null;
  maturityConfirmed: boolean | null;
  dimensions: Record<string, number | null>;
}

/**
 * The order dimension cards are shown in — Platform first, then the delivery
 * dimensions, then the cross-cutting ones.
 *
 * Explicit because the report cannot be trusted to carry an order: it is stored
 * as Postgres `jsonb`, which does not preserve object key order (it sorts keys
 * by length, then bytewise). Reading `Object.values(report.dimensions)` renders
 * the cards in whatever order the database chose, which changes as dimension
 * names change.
 */
export const DIMENSION_ORDER: DimensionId[] = [
  'platform',
  'devEx',
  'quality',
  'reliability',
  'aiEngineering',
  'security',
  'finops',
];

/** Dimension scores in display order, skipping any the report omitted. */
export function orderedDimensions(
  dimensions: Record<string, DimensionScore>,
): DimensionScore[] {
  const known = DIMENSION_ORDER.map(id => dimensions[id]).filter(Boolean);
  // Anything the backend added that this build does not know about still gets
  // rendered, after the known ones, rather than silently disappearing.
  const extra = Object.keys(dimensions)
    .filter(id => !DIMENSION_ORDER.includes(id as DimensionId))
    .map(id => dimensions[id]);
  return [...known, ...extra];
}

export const DIMENSION_LABELS: Record<DimensionId, string> = {
  platform: 'Platform Engineering',
  devEx: 'Developer Experience',
  quality: 'Quality Engineering',
  reliability: 'Reliability',
  aiEngineering: 'AI Engineering',
  security: 'Security',
  finops: 'FinOps',
};

/**
 * Where to go for the detail behind a dimension.
 *
 * These point at the pages this platform already has. The dashboard is a roll-up
 * and a router, not a replacement — `/dora`, `/finops`, `/scorecard` and `/slo`
 * already render the underlying series properly, and duplicating them here would
 * create a second place for the same numbers to drift.
 */
export const DIMENSION_DETAIL_PAGE: Partial<
  Record<DimensionId, { label: string; to: string }>
> = {
  platform: { label: 'Scorecard', to: '/scorecard' },
  quality: { label: 'Scorecard', to: '/scorecard' },
  reliability: { label: 'SLOs', to: '/slo' },
  finops: { label: 'Cost Overview', to: '/finops' },
  aiEngineering: { label: 'AI Observability', to: '/langfuse' },
  devEx: { label: 'DORA', to: '/dora' },
};

export type Band = 'strong' | 'fair' | 'weak' | 'unknown';

/** Colour band for a score. `null` is its own band — never the weak one. */
export function band(score: number | null): Band {
  if (score === null) return 'unknown';
  if (score >= 75) return 'strong';
  if (score >= 50) return 'fair';
  return 'weak';
}

export const BAND_COLOUR: Record<Band, string> = {
  strong: '#2e7d32',
  fair: '#ef6c00',
  weak: '#c62828',
  // Deliberately grey, not red. An unmeasured dimension is not a failing one,
  // and colouring it like one would say something the data does not.
  unknown: '#78909c',
};

export function formatScore(score: number | null): string {
  return score === null ? '—' : String(Math.round(score));
}

/** One line explaining a dimension's status, for the card subtitle. */
export function statusLine(dimension: DimensionScore): string {
  if (dimension.status === 'insufficient-evidence') {
    const sources = Array.from(
      new Set(dimension.missing.map(m => m.expectedFrom)),
    );
    return `Insufficient evidence — needs ${sources.join(', ')}`;
  }
  if (dimension.status === 'partial') {
    const n = dimension.missing.length;
    return `${Math.round(dimension.coverage * 100)}% signal coverage · ${n} signal${
      n === 1 ? '' : 's'
    } missing`;
  }
  return 'All signals collected';
}

/**
 * Render a raw metric value in its own units.
 *
 * The evidence rows carry values on wildly different scales — a 0.5 ratio, 45
 * minutes, 4.5 percent, 1.75 deploys a day — and showing them all bare makes the
 * table unreadable. Units are derived from the metric id's suffix, which the
 * scoring engine assigns consistently.
 */
export function formatMetricValue(metric: string, value: number): string {
  if (/Percent$/.test(metric)) return `${round(value, 1)}%`;
  if (/PerDay$/.test(metric)) return `${round(value, 2)}/day`;
  if (/Minutes$/.test(metric)) {
    return value < 60 ? `${round(value, 0)} min` : `${round(value / 60, 1)} hr`;
  }
  if (/Hours$/.test(metric)) return `${round(value, 1)} hr`;
  if (/(Ratio|Coverage|Adoption|Rate|Active)$/.test(metric)) {
    return `${round(value * 100, 1)}%`;
  }
  return String(round(value, 2));
}

function round(value: number, places: number): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

/** Relative time, for "as of" lines. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'unknown';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 90) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} hr ago`;
  return `${Math.round(hours / 24)} days ago`;
}

export interface Trend {
  delta: number;
  since: string;
}

/**
 * The trend line's text.
 *
 * A zero delta gets its own wording. Rendering it as "▲ 0" reads as an
 * improvement of nothing and points the arrow the wrong way for a figure that
 * did not move at all — two real collections agreeing is worth saying plainly.
 */
export function trendLabel(movement: Trend | undefined, now?: number): string {
  if (!movement) {
    return 'No trend yet — snapshots begin at first install and cannot be back-filled';
  }
  const when = relativeTime(movement.since, now);
  if (movement.delta === 0) return `Unchanged since ${when}`;
  const arrow = movement.delta > 0 ? '▲' : '▼';
  return `${arrow} ${Math.abs(movement.delta)} since ${when}`;
}

/**
 * Change in overall score against the oldest snapshot available.
 *
 * Returns undefined rather than zero when there is nothing to compare against.
 * Snapshots only start accumulating at first install and no source retains the
 * history to back-fill, so a fresh platform genuinely has no trend — and "0"
 * would read as "no change", which is a different and false claim.
 */
export function trend(snapshots: SnapshotRow[]): Trend | undefined {
  const scored = snapshots.filter(s => s.overallScore !== null);
  if (scored.length < 2) return undefined;

  // The API returns newest first.
  const newest = scored[0];
  const oldest = scored[scored.length - 1];
  if (newest.capturedAt === oldest.capturedAt) return undefined;

  return {
    delta: round((newest.overallScore as number) - (oldest.overallScore as number), 1),
    since: oldest.capturedAt,
  };
}

/**
 * Risks worth an executive's attention, most severe first.
 *
 * These are the report's own recommendations. The dashboard does not derive its
 * own — a risk on this page and a recommendation from the API have to be the
 * same object, or the two disagree the moment either changes.
 */
export function topRisks(
  report: Pick<HealthReport, 'recommendations'>,
  limit = 4,
): Recommendation[] {
  return report.recommendations.slice(0, limit);
}

export interface LadderRow {
  level: number;
  name: string;
  status: 'met' | 'unmet' | 'unconfirmed';
  current: boolean;
  /** Requirements not yet met, phrased for display. */
  blockers: string[];
}

/** The five levels as display rows, with the current level marked. */
export function ladder(maturity: MaturityAssessment): LadderRow[] {
  return maturity.levels.map(level => ({
    level: level.level,
    name: level.name,
    status: level.status,
    current: level.level === maturity.currentLevel,
    blockers: level.requirements
      .filter(r => r.status !== 'met')
      .map(r =>
        r.requirement.kind === 'dimension'
          ? `${DIMENSION_LABELS[r.requirement.dimension]} ≥ ${r.requirement.minScore}${
              r.actual === null ? ' (not measurable)' : ` (now ${formatScore(r.actual)})`
            }`
          : `${r.requirement.capability} (not measurable)`,
      ),
  }));
}

/**
 * The headline sentence under the score.
 *
 * Spells out what an unconfirmed level means rather than leaving the reader to
 * infer it from a badge, because "we are not Level 4" and "we cannot tell
 * whether we are Level 4" lead to different decisions.
 */
export function maturityHeadline(maturity: MaturityAssessment): string {
  if (maturity.confirmed) {
    return `Level ${maturity.currentLevel} — ${maturity.currentLevelName}. Next: Level ${maturity.targetLevel}.`;
  }
  return (
    `Level ${maturity.currentLevel} — ${maturity.currentLevelName}. ` +
    `Level ${maturity.targetLevel} cannot be assessed until the missing evidence below is collected.`
  );
}
