import { MetricSample } from '@internal/engineering-intelligence-core';
import { CollectorResult, finite, getJson, proxyTarget, CollectorContext } from './source';

// OpenCost collector — resource efficiency, from the same allocation endpoint the
// FinOps page already uses (/allocation/compute, aggregated by namespace).
//
// Only efficiency is scored here. Absolute spend is a number to report, not a
// number to score: a platform running more workloads costs more without being
// less healthy, and there is no planned-spend figure anywhere in the platform to
// score it against. Spend attribution is phase 8.

export interface AllocationResponse {
  data?: Record<
    string,
    {
      totalCost?: number;
      cpuCost?: number;
      ramCost?: number;
      pvCost?: number;
      totalEfficiency?: number;
    }
  >[];
}

/**
 * OpenCost reports `totalEfficiency` as a 0–1 ratio, but the value has been seen
 * expressed as a percentage depending on version and aggregation. Normalise
 * defensively rather than letting a 42 mean "4200% efficient" downstream.
 */
export function asRatio(value: number): number {
  return value > 1 ? value / 100 : value;
}

/**
 * Cost-weighted mean efficiency across namespaces.
 *
 * Weighting by cost rather than taking a flat mean is what stops a handful of
 * near-free namespaces from outvoting the one that dominates the bill.
 */
export function weightedEfficiency(
  allocations: AllocationResponse['data'],
): number | undefined {
  const bucket = allocations?.[0];
  if (!bucket) return undefined;

  let weighted = 0;
  let costTotal = 0;
  for (const entry of Object.values(bucket)) {
    const cost = finite(entry?.totalCost);
    const efficiency = finite(entry?.totalEfficiency);
    if (cost === undefined || efficiency === undefined) continue;
    if (cost <= 0) continue;
    weighted += asRatio(efficiency) * cost;
    costTotal += cost;
  }

  if (costTotal === 0) return undefined;
  return weighted / costTotal;
}

export async function collectOpenCost(
  ctx: CollectorContext,
): Promise<CollectorResult> {
  const base = proxyTarget(ctx.config, '/opencost');
  if (!base) {
    return {
      samples: [],
      unavailable: {
        source: 'opencost',
        reason: 'No proxy.endpoints./opencost.target is configured.',
      },
    };
  }

  const body = await getJson<AllocationResponse>(
    `${base}/allocation/compute?window=7d&aggregate=namespace&accumulate=true`,
  );

  const efficiency = weightedEfficiency(body?.data);
  if (efficiency === undefined) {
    return {
      samples: [],
      unavailable: {
        source: 'opencost',
        reason: `OpenCost at ${base} returned no priced allocations.`,
      },
    };
  }

  const samples: MetricSample[] = [
    {
      metric: 'finops.costEfficiencyRatio',
      value: efficiency,
      source: 'opencost',
      observedAt: new Date().toISOString(),
    },
  ];
  return { samples };
}
