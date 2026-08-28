import {
  HealthReport,
  MetricSample,
  WeightOverrides,
  scoreHealth,
} from '@internal/engineering-intelligence-core';
import { CollectorResult } from './source';

// Runs every collector and hands the combined samples to the scoring engine.
//
// The contract each collector honours (enforced in source.ts) is that a failure
// yields no samples rather than an exception, so one dead source degrades the
// dimensions that depended on it and leaves the rest intact. That is why this
// function has no try/catch fallback path producing default numbers — there is
// nothing to fall back to, by design.

export type Collector = () => Promise<CollectorResult>;

export interface CollectionOutcome {
  report: HealthReport;
  /** Sources that could not be read, with the reason, for the API to surface. */
  unavailable: { source: string; reason: string }[];
  /**
   * The raw samples behind the report. Returned so a second scoring model — AI
   * readiness — can be derived from the same collection rather than triggering
   * its own, which would double the load on every source and could answer one
   * question two different ways.
   */
  samples: MetricSample[];
}

export async function collectAndScore(
  collectors: Collector[],
  options: { weights?: WeightOverrides; now?: () => string } = {},
): Promise<CollectionOutcome> {
  const results = await Promise.all(
    collectors.map(async collector => {
      try {
        return await collector();
      } catch (error) {
        // A collector should never throw — source.ts swallows transport
        // failures. If one does, it is a bug in that collector, and losing its
        // samples is still better than losing the whole report.
        return {
          samples: [] as MetricSample[],
          unavailable: {
            source: 'unknown',
            reason: `Collector threw: ${error}`,
          },
        };
      }
    }),
  );

  const samples = results.flatMap(r => r.samples);
  const unavailable = results
    .map(r => r.unavailable)
    .filter((u): u is { source: string; reason: string } => !!u);

  const report = scoreHealth(samples, {
    generatedAt: options.now?.() ?? new Date().toISOString(),
    weights: options.weights,
  });

  return { report, unavailable, samples };
}
