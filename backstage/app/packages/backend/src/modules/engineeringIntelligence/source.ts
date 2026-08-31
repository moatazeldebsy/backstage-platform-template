import { Config } from '@backstage/config';

// Shared plumbing for every Engineering Intelligence collector.
//
// Two rules are enforced here rather than repeated per collector:
//
// 1. Collectors talk to the underlying source directly. They must never read
//    the Backstage UI layer — every dashboard page in extensions.tsx silently
//    substitutes plausible demo data (DORA_DEMO, DEMO_LANGFUSE_*) when its
//    source is unreachable, so a collector pointed at the UI would ingest
//    fiction and score it as fact.
//
// 2. A source that is down produces *no samples*, never a substituted value and
//    never a thrown request. The scoring engine treats an absent sample as
//    reduced coverage, which is the honest outcome; a collector that threw would
//    take the whole report down with it.

/** How long any single source gets before it is treated as absent. */
export const SOURCE_TIMEOUT_MS = 10_000;

/**
 * Resolve a source's base URL from the proxy endpoints already configured for
 * the frontend.
 *
 * The Backstage proxy is server-side, so the backend can reach every target in
 * `proxy.endpoints` today — reusing them means Prometheus, OpenCost and Langfuse
 * need no second address to keep in step with the first, in two config overlays.
 */
export function proxyTarget(config: Config, endpoint: string): string | undefined {
  // Read the endpoints map as a raw object rather than by dotted key path.
  // Proxy endpoint names begin with a slash (`/prometheus`), and a slash is not
  // a legal character in a Backstage config key — `getOptionalString(
  // 'proxy.endpoints./prometheus.target')` throws "Invalid config key" rather
  // than returning undefined.
  const endpoints = config.getOptional('proxy.endpoints') as
    | Record<string, { target?: unknown } | undefined>
    | undefined;
  const target = endpoints?.[endpoint]?.target;
  if (typeof target !== 'string' || target.trim() === '') return undefined;
  return target.replace(/\/+$/, '');
}

export interface CollectorContext {
  config: Config;
  logger: { warn(message: string): void; info(message: string): void };
}

/** The outcome of one collector: what it observed, and what it could not. */
export interface CollectorResult {
  samples: import('@internal/engineering-intelligence-core').MetricSample[];
  /** Populated when the source was unreachable or answered unusably. */
  unavailable?: { source: string; reason: string };
}

export const EMPTY: CollectorResult = { samples: [] };

/**
 * GET a JSON document, returning undefined rather than throwing on any failure.
 *
 * Every failure mode collapses to the same answer — no data — because from the
 * scoring engine's point of view a 500, a timeout and a malformed body are
 * identical: the metric was not observed.
 */
export async function getJson<T>(
  url: string,
  init: RequestInit = {},
  timeoutMs = SOURCE_TIMEOUT_MS,
): Promise<T | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...init, signal: controller.signal });
    if (!resp.ok) return undefined;
    return (await resp.json()) as T;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Guard against NaN/Infinity reaching a score. */
export function finite(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : (value as number);
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/** A ratio of two counts, safe when the denominator is zero. */
export function safeRatio(
  numerator: number,
  denominator: number,
): number | undefined {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return undefined;
  // Zero of zero is not zero percent — it is nothing observed. Returning 0 here
  // would score an empty catalog as total failure.
  if (denominator === 0) return undefined;
  return numerator / denominator;
}

/**
 * Page through a Langfuse-style list endpoint.
 *
 * Langfuse caps `limit` at 100 and answers HTTP 400 above it — which `getJson`
 * turns into no data at all, so a collector asking for 500 got nothing rather
 * than the first 100. The cap is documented in prose for `/v2/scores` and not
 * documented at all for `/traces`; only calling it reveals the latter.
 *
 * Stops at `maxPages` so a busy instance cannot make a collection unbounded. A
 * truncated read is fine here: every metric built on these is a ratio, and the
 * alternative is a collector that never finishes.
 */
export const LANGFUSE_PAGE_SIZE = 100;

export async function getPaged<T>(
  url: (page: number, limit: number) => string,
  init: RequestInit,
  maxPages = 10,
): Promise<T[] | undefined> {
  const out: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const body = await getJson<{ data?: T[]; meta?: { totalPages?: number } }>(
      url(page, LANGFUSE_PAGE_SIZE),
      init,
    );
    // A failure on page 1 is "the source did not answer"; on a later page it is
    // a partial read, and partial beats discarding what already arrived.
    if (!body || !Array.isArray(body.data)) return page === 1 ? undefined : out;
    out.push(...body.data);
    const total = body.meta?.totalPages ?? 1;
    if (page >= total || body.data.length === 0) break;
  }
  return out;
}
