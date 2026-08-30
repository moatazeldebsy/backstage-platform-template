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
import { MetricsResponse, metricsUrl } from './langfuse';

// AI cost collector — phase 8.
//
// Two Langfuse reads: `/traces` for per-trace cost (which carries the workload
// name attribution depends on) and the metrics API — `/api/public/metrics` with
// an observations query grouped by model — for the per-model rollup Langfuse
// computes itself. The query is built in `langfuse.ts` and shared, so both
// collectors read one consistent set of rows.
//
// The per-model figures deliberately come from Langfuse's own aggregation rather
// than being summed here. Langfuse prices a generation from its model table at
// ingest time; recomputing cost client-side would need that table and would
// drift from what the Langfuse UI shows the same person on the next tab.

export interface TraceListing {
  data?: { name?: string; totalCost?: number; timestamp?: string }[];
}

/**
 * Per-model costs and token counts, from the observations metrics rows.
 *
 * Langfuse v3 already groups by model, so this only has to fold duplicate rows
 * together rather than aggregate raw usage. Rows whose model is null are
 * skipped: those are observations that are not generations, so they have no
 * model to attribute to, and inventing a bucket for them would put spans in a
 * per-model cost table.
 */
export function modelCosts(body: MetricsResponse | undefined): ModelCost[] {
  const byModel = new Map<string, ModelCost>();
  for (const row of body?.data ?? []) {
    const model = row.providedModelName;
    if (!model) continue;
    const acc = byModel.get(model) ?? {
      model,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    acc.costUsd += finite(row.totalCost) ?? 0;
    acc.inputTokens += finite(row.inputTokens) ?? 0;
    acc.outputTokens += finite(row.outputTokens) ?? 0;
    byModel.set(model, acc);
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
    getJson<MetricsResponse>(metricsUrl(base, from, new Date().toISOString()), {
      headers,
    }),
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
