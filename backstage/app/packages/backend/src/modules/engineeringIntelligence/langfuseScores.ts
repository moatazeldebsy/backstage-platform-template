import {
  CATEGORY_METRIC_IDS,
  EvalScore,
  EvaluationReport,
  MetricSample,
  summariseEvaluation,
} from '@internal/engineering-intelligence-core';
import {
  CollectorContext,
  CollectorResult,
  getJson,
  proxyTarget,
} from './source';
import { langfuseAuth } from './langfuse';

// Evaluation results, read from Langfuse scores — phase 7.
//
// The producer is test-suites/test-deepeval: conftest.py records each metric as
// `type(m).__name__`, and push_to_langfuse.py writes two Langfuse scores per
// assertion — a NUMERIC one named for the metric, and a BOOLEAN one named
// `<metric>_pass`. This collector reverses that pairing.
//
// A caveat that is not this collector's to fix: that push only reaches a
// *publicly reachable* Langfuse. A GitHub-hosted runner cannot see
// langfuse-web.ml-platform.svc.cluster.local, and the local instance sits behind
// langfuse.idp.local on a Kind cluster, so on most installs there will be no
// scores at all. That is reported as absent rather than as zero — an untested
// model is unknown, not unsafe.

const PASS_SUFFIX = '_pass';

export interface LangfuseScore {
  name?: string;
  value?: number;
  dataType?: string;
  timestamp?: string;
  traceId?: string;
  trace?: { name?: string; tags?: string[] };
}

export interface ScoresResponse {
  data?: LangfuseScore[];
}

/**
 * Fold Langfuse's two-score-per-assertion shape back into one EvalScore.
 *
 * The BOOLEAN `<metric>_pass` carries the verdict and the NUMERIC one carries
 * the value; they are joined on trace id, because the same metric can appear
 * many times across a suite and pairing by name alone would merge unrelated
 * assertions.
 */
export function toEvalScores(scores: LangfuseScore[]): EvalScore[] {
  const byTrace = new Map<string, EvalScore>();
  const orphans: EvalScore[] = [];

  for (const score of scores) {
    const name = score.name;
    if (!name) continue;

    const isVerdict = name.endsWith(PASS_SUFFIX);
    const metric = isVerdict ? name.slice(0, -PASS_SUFFIX.length) : name;
    const observedAt = score.timestamp ?? new Date().toISOString();
    const suite = score.trace?.name;

    // Without a trace id there is nothing to pair on, so keep it whole rather
    // than risk merging two unrelated assertions of the same metric.
    if (!score.traceId) {
      orphans.push(
        isVerdict
          ? { metric, passed: score.value === 1, observedAt, suite }
          : { metric, value: score.value, observedAt, suite },
      );
      continue;
    }

    const key = `${score.traceId}:${metric}`;
    const existing = byTrace.get(key) ?? { metric, observedAt, suite };
    if (isVerdict) existing.passed = score.value === 1;
    else existing.value = score.value;
    existing.suite = existing.suite ?? suite;
    byTrace.set(key, existing);
  }

  return [...byTrace.values(), ...orphans];
}

export async function collectLangfuseScores(
  ctx: CollectorContext,
): Promise<CollectorResult & { evaluation?: EvaluationReport }> {
  const base = proxyTarget(ctx.config, '/langfuse');
  if (!base) {
    return {
      samples: [],
      unavailable: {
        source: 'langfuse-scores',
        reason: 'No proxy.endpoints./langfuse.target is configured.',
      },
    };
  }

  const auth = langfuseAuth(ctx.config);
  if ('reason' in auth) {
    return {
      samples: [],
      unavailable: { source: 'langfuse-scores', reason: auth.reason },
    };
  }

  const body = await getJson<ScoresResponse>(
    // v2, not v1: `/api/public/scores` is POST-only in Langfuse v3 and the GET
    // moved to `/api/public/v2/scores`. The old path answered 405, which
    // `getJson` turned into "no scores" — a broken call that read as an
    // organisation with no evaluation suite.
    `${base}/api/public/v2/scores?limit=500`,
    { headers: { Authorization: auth.header } },
  );

  if (!body || !Array.isArray(body.data)) {
    return {
      samples: [],
      unavailable: {
        source: 'langfuse-scores',
        reason: `Langfuse at ${base} did not answer with a score list.`,
      },
    };
  }

  const evaluation = summariseEvaluation(toEvalScores(body.data));

  if (evaluation.assertions === 0) {
    // No evaluation has been recorded. Note the most likely reason rather than
    // leaving a reader to wonder whether the suite is broken.
    return {
      samples: [],
      evaluation,
      unavailable: {
        source: 'langfuse-scores',
        reason:
          'No evaluation results recorded. push_to_langfuse.py only reaches a publicly reachable Langfuse, so CI runs against a cluster-local instance push nothing.',
      },
    };
  }

  const observedAt = new Date().toISOString();
  const samples: MetricSample[] = [
    {
      metric: 'ai.evalPassRatio',
      value: evaluation.passRate as number,
      source: 'langfuse-scores',
      observedAt,
      labels: {
        assertions: String(evaluation.assertions),
        passed: String(evaluation.passed),
      },
    },
  ];

  // One sample per category that actually reported a verdict. A category nobody
  // evaluated stays absent, so the readiness area it feeds says "insufficient
  // evidence" instead of scoring zero — an untested risk is unknown, not safe.
  for (const category of evaluation.categories) {
    const metric = CATEGORY_METRIC_IDS[category.category];
    if (!metric || category.passRate === null) continue;
    samples.push({
      metric,
      value: category.passRate,
      source: 'langfuse-scores',
      observedAt,
      labels: {
        metrics: category.metrics.join(','),
        assertions: String(category.assertions),
      },
    });
  }

  return { samples, evaluation };
}
