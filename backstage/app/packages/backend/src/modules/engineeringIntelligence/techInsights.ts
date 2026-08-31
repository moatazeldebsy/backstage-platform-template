import { MetricSample } from '@internal/engineering-intelligence-core';
import { CollectorResult, getJson, safeRatio } from './source';

// Tech Insights collector.
//
// This collector *consumes* the `idp-entity-facts` retriever's output. It does
// not recompute any check.
//
// That restraint is the point. The Bronze/Silver/Gold scorecard is already
// implemented three times in this repo — as facts in
// packages/backend/src/modules/idpTechInsights.ts, client-side in
// packages/app/src/scorecard.ts, and again in Python in
// observability/tech-insights-exporter/exporter.py — and the three have already
// drifted (gold is 9 checks in one and 10 in another). A fourth implementation
// here would be the worst of the four, because it would be the one feeding an
// executive health score. See docs/engineering-intelligence/scoring.md.

const RETRIEVER_ID = 'idp-entity-facts';

/** Checks that make up the security signal — scanning controls, not findings. */
export const SECURITY_CHECKS = [
  'has-sonar-scanning',
  'has-snyk-scanning',
  'has-trivy-scanning',
] as const;

/** Checks that make up the AI governance signal. */
export const AI_GOVERNANCE_CHECKS = [
  'has-model-card',
  'has-eval-suite',
  'has-ai-observability',
] as const;

export interface FactsResponse {
  [retrieverId: string]: { facts?: Record<string, unknown> } | undefined;
}

/** A fact is only a pass when it is literally true — absent is not false. */
function isPass(facts: Record<string, unknown>, check: string): boolean {
  return facts[check] === true;
}

/**
 * Roll a set of per-entity fact bundles up into the platform-wide signals.
 *
 * Pure, and exported so the aggregation can be tested without a running
 * Tech Insights backend.
 */
export function techInsightsSamples(
  bundles: Record<string, unknown>[],
  observedAt: string,
): MetricSample[] {
  const samples: MetricSample[] = [];
  const push = (metric: string, value: number | undefined) => {
    if (value === undefined) return;
    samples.push({ metric, value, source: 'techInsights', observedAt });
  };

  if (bundles.length === 0) return samples;

  // Overall check pass ratio, across every fact the retriever emitted. Counting
  // the facts present per entity rather than assuming a fixed total means adding
  // a check to idpTechInsights.ts does not silently break this number.
  let passed = 0;
  let evaluated = 0;
  for (const facts of bundles) {
    for (const [, value] of Object.entries(facts)) {
      if (typeof value !== 'boolean') continue;
      evaluated += 1;
      if (value) passed += 1;
    }
  }
  push('scorecard.checksPassedRatio', safeRatio(passed, evaluated));

  const ratioOver = (checks: readonly string[]) => {
    let ok = 0;
    let seen = 0;
    for (const facts of bundles) {
      for (const check of checks) {
        // Only count entities the retriever actually evaluated for this check.
        if (!(check in facts)) continue;
        seen += 1;
        if (isPass(facts, check)) ok += 1;
      }
    }
    return safeRatio(ok, seen);
  };

  push('security.scanningControlsRatio', ratioOver(SECURITY_CHECKS));
  push('ai.governanceChecksRatio', ratioOver(AI_GOVERNANCE_CHECKS));

  // The same three facts again, split apart. The blended ratio above answers
  // "how governed is AI overall" for the Engineering Health model; the AI
  // readiness model needs them separately, because a model card, an evaluation
  // suite and wired observability are three different kinds of maturity and
  // averaging them hides which one is missing.
  push('ai.modelCardRatio', ratioOver(['has-model-card']));
  push('ai.evalSuiteRatio', ratioOver(['has-eval-suite']));
  push('ai.observabilityWiredRatio', ratioOver(['has-ai-observability']));

  return samples;
}

export interface TechInsightsAccess {
  baseUrl(): Promise<string>;
  token(): Promise<string>;
  /** Entity refs to fetch facts for, normally every Component in the catalog. */
  entityRefs(): Promise<string[]>;
}

export async function collectTechInsights(
  access: TechInsightsAccess,
): Promise<CollectorResult> {
  const observedAt = new Date().toISOString();

  let base: string;
  let token: string;
  let refs: string[];
  try {
    base = await access.baseUrl();
    token = await access.token();
    refs = await access.entityRefs();
  } catch (error) {
    return {
      samples: [],
      unavailable: {
        source: 'techInsights',
        reason: `Could not reach Tech Insights: ${error}`,
      },
    };
  }

  if (refs.length === 0) {
    return {
      samples: [],
      unavailable: {
        source: 'techInsights',
        reason: 'No Component entities to collect facts for.',
      },
    };
  }

  const bundles = await Promise.all(
    refs.map(async ref => {
      const body = await getJson<FactsResponse>(
        `${base}/facts/latest?entity=${encodeURIComponent(ref)}` +
          `&ids[]=${RETRIEVER_ID}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      return body?.[RETRIEVER_ID]?.facts;
    }),
  );

  const present = bundles.filter(
    (b): b is Record<string, unknown> => !!b && Object.keys(b).length > 0,
  );

  if (present.length === 0) {
    // The retriever runs on a 30-minute cadence and has produced nothing yet, or
    // the API is down. Either way there is no evidence, so report none.
    return {
      samples: [],
      unavailable: {
        source: 'techInsights',
        reason: `No ${RETRIEVER_ID} facts have been recorded yet.`,
      },
    };
  }

  return { samples: techInsightsSamples(present, observedAt) };
}
