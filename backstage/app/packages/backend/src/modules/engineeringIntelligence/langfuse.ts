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

// Langfuse v3's metrics API (`GET /api/public/metrics?query=<json>`). It replaced
// `/api/public/metrics/daily`, which this collector used to call and which no
// longer exists — the request 404s, and because `getJson` swallows failures that
// looked exactly like "Langfuse is not deployed yet" rather than a broken call.
//
// The query is a JSON string, and the response rows carry whatever the query
// asked for, so the shape below is the shape OUR query produces and nothing
// more general. Field names are taken from the published OpenAPI description
// rather than guessed: the model dimension is `providedModelName`, not `model`.
export interface MetricsRow {
  providedModelName?: string | null;
  count?: number;
  totalCost?: number;
  inputTokens?: number;
  outputTokens?: number;
  [key: string]: unknown;
}

export interface MetricsResponse {
  data?: MetricsRow[];
}

/**
 * Build the `query` parameter for the observations view, grouped by model.
 *
 * One query serves both callers: this collector needs the observation count and
 * the distinct model count, and `aiCost.ts` needs per-model cost and tokens.
 * Asking once and sharing the rows keeps the two consistent — two queries could
 * disagree if a trace landed between them.
 */
export function observationsByModelQuery(from: string, to: string): string {
  return JSON.stringify({
    view: 'observations',
    dimensions: [{ field: 'providedModelName' }],
    metrics: [
      { measure: 'count', aggregation: 'count' },
      { measure: 'totalCost', aggregation: 'sum' },
      { measure: 'inputTokens', aggregation: 'sum' },
      { measure: 'outputTokens', aggregation: 'sum' },
    ],
    fromTimestamp: from,
    toTimestamp: to,
  });
}

export function metricsUrl(base: string, from: string, to: string): string {
  const q = encodeURIComponent(observationsByModelQuery(from, to));
  return `${base}/api/public/metrics?query=${q}`;
}

/** Paginated list envelope. `meta.totalItems` is how we count traces now. */
export interface TraceCount {
  meta?: { totalItems?: number };
}

/**
 * Base64 of `not-configured`, the placeholder `app-config.local.yaml` substitutes
 * when `LANGFUSE_BASIC_AUTH` is unset. Backstage needs *some* value there or the
 * proxy fails to start, so its presence means Langfuse was never deployed —
 * making a request with it would earn a 401 and report the wrong reason.
 */
const UNCONFIGURED_BASIC = 'bm90LWNvbmZpZ3VyZWQ=';

export type LangfuseAuth =
  | { header: string }
  | { reason: string };

/**
 * The credential for Langfuse's public API.
 *
 * Prefers an explicit `langfuse.publicKey` / `langfuse.secretKey` pair, then
 * falls back to the Authorization header already configured on the `/langfuse`
 * proxy endpoint. The fallback is what makes this work on an unmodified local
 * install: `app-config.local.yaml` supplies the project key pair as a single
 * pre-encoded `LANGFUSE_BASIC_AUTH` value on the proxy, and requiring a second
 * copy under different key names would mean the collector reported Langfuse
 * unavailable on a cluster where Langfuse was demonstrably running.
 */
export function langfuseAuth(config: CollectorContext['config']): LangfuseAuth {
  const publicKey = config.getOptionalString('langfuse.publicKey');
  const secretKey = config.getOptionalString('langfuse.secretKey');
  if (publicKey && secretKey) {
    return {
      header: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`,
    };
  }

  const endpoints = config.getOptional('proxy.endpoints') as
    | Record<string, { headers?: Record<string, unknown> } | undefined>
    | undefined;
  const header = endpoints?.['/langfuse']?.headers?.Authorization;

  if (typeof header === 'string' && header.trim() !== '') {
    if (header.includes(UNCONFIGURED_BASIC)) {
      return {
        reason:
          'The /langfuse proxy still carries the not-configured placeholder, so Langfuse has not been deployed. Set LANGFUSE_BASIC_AUTH from the langfuse-init secret.',
      };
    }
    return { header };
  }

  return {
    reason:
      'No Langfuse credential: set langfuse.publicKey / langfuse.secretKey, or an Authorization header on the /langfuse proxy endpoint.',
  };
}

export interface PromptListing {
  data?: { name?: string; versions?: unknown[]; labels?: string[] }[];
}

/**
 * Agent prompts under version control in Langfuse.
 *
 * "Managed" means the prompt carries a `production` label — that is what
 * scripts/sync-agent-prompts.py pushes and what its drift check compares
 * against. A prompt uploaded once with no production label is a draft, and
 * counting it would say the platform has prompt management when what it has is
 * a copy.
 */
export function promptFacts(body: PromptListing | undefined): {
  total: number;
  managed: number;
} | undefined {
  const prompts = body?.data;
  if (!Array.isArray(prompts)) return undefined;
  const managed = prompts.filter(p =>
    (p.labels ?? []).includes('production'),
  ).length;
  return { total: prompts.length, managed };
}

export interface LangfuseRollup {
  traces: number;
  observations: number;
  costUsd: number;
  models: number;
}

/**
 * Roll the per-model rows up. Pure, so it is testable.
 *
 * `traces` comes from a separate call rather than from these rows: the metrics
 * API has no documented `traces` view, and counting observations would overstate
 * traces by however many spans each one carries.
 */
export function rollup(
  body: MetricsResponse | undefined,
  traces: number | undefined,
): LangfuseRollup | undefined {
  const rows = body?.data;
  if (!Array.isArray(rows)) return undefined;

  let observations = 0;
  let costUsd = 0;
  const models = new Set<string>();

  for (const row of rows) {
    observations += finite(row.count) ?? 0;
    costUsd += finite(row.totalCost) ?? 0;
    // A null model is Langfuse's bucket for observations that are not
    // generations. It is a real row, but it is not a model.
    if (row.providedModelName) models.add(row.providedModelName);
  }

  return { traces: finite(traces) ?? 0, observations, costUsd, models: models.size };
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

  const auth = langfuseAuth(ctx.config);
  if ('reason' in auth) {
    return { samples: [], unavailable: { source: 'langfuse', reason: auth.reason } };
  }

  const to = new Date().toISOString();
  const from = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const headers = { Authorization: auth.header };

  // limit=1 because only `meta.totalItems` is wanted; pulling 500 trace bodies
  // to count them would be pure waste.
  const [body, traceCount] = await Promise.all([
    getJson<MetricsResponse>(metricsUrl(base, from, to), { headers }),
    getJson<TraceCount>(
      `${base}/api/public/traces?limit=1&fromTimestamp=${encodeURIComponent(from)}`,
      { headers },
    ),
  ]);

  const rolled = rollup(body, traceCount?.meta?.totalItems);
  if (!rolled) {
    return {
      samples: [],
      unavailable: {
        source: 'langfuse',
        reason: `Langfuse at ${base} did not answer.`,
      },
    };
  }

  const observedAt = new Date().toISOString();

  // Binary by design, and labelled as such on the signal in dimensions.ts:
  // observability is either receiving traces or it is not. Anything finer would
  // require attribution Langfuse does not currently carry.
  const samples: MetricSample[] = [
    {
      metric: 'ai.observabilityActive',
      value: rolled.traces > 0 ? 1 : 0,
      source: 'langfuse',
      observedAt,
      labels: {
        traces: String(rolled.traces),
        observations: String(rolled.observations),
        models: String(rolled.models),
        costUsd7d: rolled.costUsd.toFixed(4),
      },
    },
  ];

  // Prompt management, for the AI readiness model. A separate call, and a
  // failure here must not lose the observability sample above — the two answer
  // different questions and one being unavailable says nothing about the other.
  const prompts = promptFacts(
    await getJson<PromptListing>(`${base}/api/public/v2/prompts?limit=100`, {
      headers: { Authorization: auth.header },
    }),
  );
  if (prompts && prompts.total > 0) {
    samples.push({
      metric: 'ai.promptsManagedRatio',
      value: prompts.managed / prompts.total,
      source: 'langfuse',
      observedAt,
      labels: { total: String(prompts.total), managed: String(prompts.managed) },
    });
  }
  // No prompts at all is not bad prompt management — it is a platform with no
  // prompts, so the signal stays absent rather than scoring zero.

  return { samples };
}
