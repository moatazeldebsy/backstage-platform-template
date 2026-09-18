import { MetricSample } from '@internal/engineering-intelligence-core';
import { CollectorContext, CollectorResult, finite, getJson, proxyTarget } from './source';

// LiteLLM spend collector — ADR-0008.
//
// Parallel to aiCost.ts's Langfuse-derived `ai.costAttributedRatio` —
// intentionally not merged. ADR-0008 already flagged the triple-counting risk
// of measuring the same AI spend from three vantage points (agentgateway's own
// telemetry, Langfuse traces, and LiteLLM's own per-key accounting) and defers
// resolving it to a later, dedicated decision. This collector emits its own,
// distinct metric names and must never write `ai.costAttributedRatio` or
// import anything from aiCost.ts.
//
// Deliberately not declared in dimensions.ts: this is an informational signal,
// not a scoring input. Collecting a metric and scoring on it are separate
// steps in this system, and there is no product decision yet that LiteLLM's
// number should move the Platform Health score.
//
// Endpoint confirmed against a live local instance (v1.100.1): `/user/info`
// returns the proxy admin user's cumulative spend with zero query params —
// no date range, no Enterprise license required, unlike `/global/spend/report`
// (which 400s on the OSS build with "You must be a LiteLLM Enterprise user").

interface LitellmUserInfoResponse {
  user_info?: { spend?: number };
}

export async function collectLitellmSpend(
  ctx: CollectorContext,
): Promise<CollectorResult> {
  const base = proxyTarget(ctx.config, '/litellm');
  if (!base) {
    return {
      samples: [],
      unavailable: {
        source: 'litellm-spend',
        reason: 'No proxy.endpoints./litellm.target is configured.',
      },
    };
  }

  const body = await getJson<LitellmUserInfoResponse>(`${base}/user/info`);
  const spend = finite(body?.user_info?.spend);

  if (spend === undefined) {
    return {
      samples: [],
      unavailable: {
        source: 'litellm-spend',
        reason: `LiteLLM at ${base} did not answer /user/info with a usable spend figure.`,
      },
    };
  }

  const samples: MetricSample[] = [
    {
      metric: 'ai.litellmSpendUsd',
      value: spend,
      source: 'litellm-spend',
      observedAt: new Date().toISOString(),
    },
  ];

  return { samples };
}
