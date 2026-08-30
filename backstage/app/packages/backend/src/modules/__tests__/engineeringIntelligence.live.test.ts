// Live-source verification for the AI collectors.
//
// The failure this file prevents is the one unit tests structurally cannot: a
// collector that parses its own fixture perfectly while calling an endpoint the
// real service does not serve. Every fixture in the suite next door was written
// by the same person who wrote the collector, so the two agree by construction.
// Running against a real instance is the only thing that disagrees.
//
// It has already earned its place. Against a real MLflow 2.13.0 this found the
// collector POSTing to `registered-models/search`, which answers
// `Allow: HEAD, OPTIONS, GET` and returns 405 — and a unit test that asserted
// the POST, so the bug looked verified.
//
// Skipped unless a URL is supplied, so CI and a normal `yarn test` are
// unaffected:
//
//   docker run -d --name mlflow-verify -p 5011:5000 ghcr.io/mlflow/mlflow:v2.13.0 \
//     mlflow server --host 0.0.0.0 --port 5000 --backend-store-uri sqlite:////tmp/mlflow.db
//   LIVE_MLFLOW_URL=http://localhost:5011 CI=true yarn test engineeringIntelligence.live
//
//   LIVE_LANGFUSE_URL=http://localhost:3030 LIVE_LANGFUSE_BASIC=<base64 pk:sk> \
//     CI=true yarn test engineeringIntelligence.live

import { ConfigReader } from '@backstage/config';
import { collectMlflow } from '../engineeringIntelligence/mlflow';
import { collectLangfuse } from '../engineeringIntelligence/langfuse';
import { collectLangfuseScores } from '../engineeringIntelligence/langfuseScores';
import { collectAiCost } from '../engineeringIntelligence/aiCost';

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => logger,
} as any;

function ctxFor(path: string, target: string, authHeader?: string) {
  return {
    config: new ConfigReader({
      proxy: {
        endpoints: {
          [path]: {
            target,
            ...(authHeader ? { headers: { Authorization: authHeader } } : {}),
          },
        },
      },
    }),
    logger,
  };
}

const MLFLOW = process.env.LIVE_MLFLOW_URL;
const LANGFUSE = process.env.LIVE_LANGFUSE_URL;
const LANGFUSE_BASIC = process.env.LIVE_LANGFUSE_BASIC;

const describeMlflow = MLFLOW ? describe : describe.skip;
const describeLangfuse = LANGFUSE && LANGFUSE_BASIC ? describe : describe.skip;

describeMlflow('MLflow — against a live registry', () => {
  const ctx = () => ctxFor('/mlflow', MLFLOW as string);

  it('reaches the registry and reports a ratio, or says the registry is empty', async () => {
    const result = await collectMlflow(ctx());
    const reason = result.unavailable?.reason ?? '';

    // The distinction that matters: an unreachable MLflow and an empty one must
    // not produce the same answer.
    expect(reason).not.toMatch(/did not answer/);
    expect(result.facts).toBeDefined();

    const registered = result.facts?.registered ?? 0;
    const versioned = result.facts?.versioned ?? 0;
    const row = result.samples.find(s => s.metric === 'ai.modelVersionedRatio');

    // Asserted as one object rather than a branch, so the empty and populated
    // cases are checked by the same expectation and neither can silently skip.
    expect({
      hasSample: !!row,
      value: row?.value ?? null,
      source: row?.source ?? null,
      timestampParses: row ? !Number.isNaN(Date.parse(row.observedAt)) : null,
      saysEmpty: /No models are registered/.test(reason),
    }).toEqual({
      hasSample: registered > 0,
      value: registered > 0 ? versioned / registered : null,
      source: registered > 0 ? 'mlflow' : null,
      timestampParses: registered > 0 ? true : null,
      saysEmpty: registered === 0,
    });
  });
});

describeLangfuse('Langfuse — against a live instance', () => {
  const ctx = () =>
    ctxFor('/langfuse', LANGFUSE as string, `Basic ${LANGFUSE_BASIC}`);

  it('reads observability and prompt facts without a transport error', async () => {
    const result = await collectLangfuse(ctx());
    expect(result.unavailable?.reason ?? '').not.toMatch(/did not answer/);
    const active = result.samples.find(s => s.metric === 'ai.observabilityActive');
    expect(active).toBeDefined();
    expect([0, 1]).toContain(active!.value);
  });

  it('reads evaluation scores from the v2 endpoint', async () => {
    // v1 /api/public/scores is POST-only in Langfuse v3; a GET there answers 405
    // and reads downstream as "no evaluation suite exists".
    const result = await collectLangfuseScores(ctx());
    expect(result.unavailable?.reason ?? '').not.toMatch(
      /did not answer with a score list/,
    );
  });

  it('reads AI spend from the metrics API', async () => {
    // /api/public/metrics/daily was removed in v3; the query-based
    // /api/public/metrics replaced it.
    const result = await collectAiCost(ctx(), { owners: () => ({}) });
    expect(result.unavailable?.reason ?? '').not.toMatch(/did not answer/);
  });
});
