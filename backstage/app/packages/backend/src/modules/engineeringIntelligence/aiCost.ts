import {
  AiCostReport,
  MetricSample,
  ModelCost,
  TraceCost,
  summariseAiCost,
} from '@internal/engineering-intelligence-core';
import {
  CollectorContext,
  CollectorResult,
  finite,
  getJson,
  proxyTarget,
} from './source';
import { langfuseAuth } from './langfuse';
import { DailyMetrics } from './langfuse';

// AI cost collector — phase 8.
//
// Two Langfuse reads: `/traces` for per-trace cost (which carries the workload
// name attribution depends on) and `/metrics/daily` for the per-model rollup
// Langfuse computes itself.
//
// The per-model figures deliberately come from Langfuse's own aggregation rather
// than being summed here. Langfuse prices a generation from its model table at
// ingest time; recomputing cost client-side would need that table and would
// drift from what the Langfuse UI shows the same person on the next tab.

export interface TraceListing {
  data?: { name?: string; totalCost?: number; timestamp?: string }[];
}

/** Per-model costs and token counts, rolled up from the daily buckets. */
export function modelCosts(body: DailyMetrics | undefined): ModelCost[] {
  const byModel = new Map<string, ModelCost>();
  for (const day of body?.data ?? []) {
    for (const usage of day.usage ?? []) {
      if (!usage.model) continue;
      const row = byModel.get(usage.model) ?? {
        model: usage.model,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
      row.costUsd += finite(usage.totalCost) ?? 0;
      row.inputTokens += finite(usage.inputUsage) ?? 0;
      row.outputTokens += finite(usage.outputUsage) ?? 0;
      byModel.set(usage.model, row);
    }
  }
  return [...byModel.values()];
}

export function traceCosts(body: TraceListing | undefined): TraceCost[] {
  return (body?.data ?? [])
    .filter(t => typeof t.name === 'string')
    .map(t => ({
      name: t.name as string,
      costUsd: finite(t.totalCost) ?? 0,
      observedAt: t.timestamp ?? new Date().toISOString(),
    }));
}

export interface AiCostAccess {
  /** Component name → owner, from the catalog collector. */
  owners(): Record<string, string>;
}

const WINDOW_DAYS = 7;

export async function collectAiCost(
  ctx: CollectorContext,
  access: AiCostAccess,
): Promise<CollectorResult & { cost?: AiCostReport }> {
  const base = proxyTarget(ctx.config, '/langfuse');
  if (!base) {
    return {
      samples: [],
      unavailable: {
        source: 'ai-cost',
        reason: 'No proxy.endpoints./langfuse.target is configured.',
      },
    };
  }

  const auth = langfuseAuth(ctx.config);
  if ('reason' in auth) {
    return {
      samples: [],
      unavailable: { source: 'ai-cost', reason: auth.reason },
    };
  }

  const from = new Date(
    Date.now() - WINDOW_DAYS * 24 * 3600 * 1000,
  ).toISOString();
  const headers = { Authorization: auth.header };

  const [traceBody, dailyBody] = await Promise.all([
    getJson<TraceListing>(
      `${base}/api/public/traces?limit=500&fromTimestamp=${encodeURIComponent(from)}`,
      { headers },
    ),
    getJson<DailyMetrics>(
      `${base}/api/public/metrics/daily?fromTimestamp=${encodeURIComponent(from)}`,
      { headers },
    ),
  ]);

  if (!traceBody || !Array.isArray(traceBody.data)) {
    return {
      samples: [],
      unavailable: {
        source: 'ai-cost',
        reason: `Langfuse at ${base} did not answer with a trace list.`,
      },
    };
  }

  const report = summariseAiCost(
    traceCosts(traceBody),
    access.owners(),
    modelCosts(dailyBody),
    { windowDays: WINDOW_DAYS },
  );

  if (report.totalUsd <= 0) {
    // No spend is not perfect attribution. A platform with no AI traffic has
    // nothing to attribute, and reporting 100% would claim a discipline it has
    // never been tested on.
    return {
      samples: [],
      cost: report,
      unavailable: {
        source: 'ai-cost',
        reason: `No AI spend recorded in the last ${WINDOW_DAYS} days, so attribution cannot be measured.`,
      },
    };
  }

  const samples: MetricSample[] = [
    {
      metric: 'ai.costAttributedRatio',
      value: report.attributedRatio as number,
      source: 'ai-cost',
      observedAt: report.generatedAt,
      labels: {
        totalUsd: String(report.totalUsd),
        attributedUsd: String(report.attributedUsd),
        teams: String(report.byTeam.length),
      },
    },
  ];

  return { samples, cost: report };
}
