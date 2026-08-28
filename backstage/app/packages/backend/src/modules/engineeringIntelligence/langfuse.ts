import { MetricSample } from '@internal/engineering-intelligence-core';
import {
  CollectorContext,
  CollectorResult,
  finite,
  getJson,
  proxyTarget,
} from './source';

// Langfuse collector — LLM observability.
//
// What this deliberately does NOT produce: a per-service or per-team AI figure.
// Langfuse traces in this platform carry a trace name, a session id and a user
// id, but nothing that joins back to a catalog entity or an owning team. A
// "percentage of AI services under observation" would therefore be a guess
// dressed as a measurement, so the signal collected here is the honest one the
// data supports: whether LLM observability is receiving traffic at all.
//
// Per-service and per-team AI cost attribution is phase 8, and it needs a join
// key added at the emitting end (services/*/src/telemetry.ts) before it can be
// anything other than invented.

export interface DailyMetrics {
  data?: {
    date?: string;
    countTraces?: number;
    countObservations?: number;
    totalCost?: number;
    usage?: {
      model?: string;
      inputUsage?: number;
      outputUsage?: number;
      totalCost?: number;
    }[];
  }[];
}

export interface LangfuseRollup {
  traces: number;
  observations: number;
  costUsd: number;
  models: number;
}

/** Roll the per-day, per-model buckets up. Pure, so it is testable. */
export function rollup(body: DailyMetrics | undefined): LangfuseRollup | undefined {
  const days = body?.data;
  if (!Array.isArray(days)) return undefined;

  let traces = 0;
  let observations = 0;
  let costUsd = 0;
  const models = new Set<string>();

  for (const day of days) {
    traces += finite(day.countTraces) ?? 0;
    observations += finite(day.countObservations) ?? 0;
    costUsd += finite(day.totalCost) ?? 0;
    for (const usage of day.usage ?? []) {
      if (usage.model) models.add(usage.model);
    }
  }

  return { traces, observations, costUsd, models: models.size };
}

export async function collectLangfuse(
  ctx: CollectorContext,
): Promise<CollectorResult> {
  const base = proxyTarget(ctx.config, '/langfuse');
  if (!base) {
    return {
      samples: [],
      unavailable: {
        source: 'langfuse',
        reason: 'No proxy.endpoints./langfuse.target is configured.',
      },
    };
  }

  // Langfuse authenticates with HTTP Basic over the project key pair. The
  // frontend never holds these — the proxy injects them — so a server-side
  // collector needs them directly.
  const publicKey = ctx.config.getOptionalString('langfuse.publicKey');
  const secretKey = ctx.config.getOptionalString('langfuse.secretKey');
  if (!publicKey || !secretKey) {
    return {
      samples: [],
      unavailable: {
        source: 'langfuse',
        reason:
          'langfuse.publicKey / langfuse.secretKey are not configured for server-side collection.',
      },
    };
  }

  const from = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const auth = Buffer.from(`${publicKey}:${secretKey}`).toString('base64');
  const body = await getJson<DailyMetrics>(
    `${base}/api/public/metrics/daily?fromTimestamp=${encodeURIComponent(from)}`,
    { headers: { Authorization: `Basic ${auth}` } },
  );

  const rolled = rollup(body);
  if (!rolled) {
    return {
      samples: [],
      unavailable: {
        source: 'langfuse',
        reason: `Langfuse at ${base} did not answer.`,
      },
    };
  }

  // Binary by design, and labelled as such on the signal in dimensions.ts:
  // observability is either receiving traces or it is not. Anything finer would
  // require attribution Langfuse does not currently carry.
  const samples: MetricSample[] = [
    {
      metric: 'ai.observabilityActive',
      value: rolled.traces > 0 ? 1 : 0,
      source: 'langfuse',
      observedAt: new Date().toISOString(),
      labels: {
        traces: String(rolled.traces),
        observations: String(rolled.observations),
        models: String(rolled.models),
        costUsd7d: rolled.costUsd.toFixed(4),
      },
    },
  ];
  return { samples };
}
