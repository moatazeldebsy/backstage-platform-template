import { MetricSample } from '@internal/engineering-intelligence-core';
import {
  CollectorContext,
  CollectorResult,
  finite,
  getJson,
  proxyTarget,
  safeRatio,
} from './source';

// Prometheus collector.
//
// A note on metric names: docs/dora-finops.md documented `idp_deploy_frequency`,
// `idp_lead_time_seconds`, `idp_change_failure_rate` and `idp_mttr_seconds`.
// None of those series exist. The real ones are the `dora_*` names below, as
// used by the DORA entity tab in extensions.tsx and emitted by
// local/observability/dora/dora-exporter.py. The doc has been corrected in the
// same change that added this file; build from the names here, not from prose.
//
// A note on history: Prometheus retention is 6h locally and 30d on AWS, with no
// Thanos/Mimir and no recording rules for any of these series. Only instantaneous
// values are available, which is why the plugin persists its own snapshots.

export interface PromResult {
  status?: string;
  data?: {
    resultType?: string;
    result?: { metric?: Record<string, string>; value?: [number, string] }[];
  };
}

/** Sum of an instant vector, or undefined when the query returned nothing. */
export function vectorSum(body: PromResult | undefined): number | undefined {
  const rows = body?.data?.result;
  if (!Array.isArray(rows) || rows.length === 0) return undefined;
  let total = 0;
  let seen = 0;
  for (const row of rows) {
    const value = finite(row.value?.[1]);
    if (value === undefined) continue;
    total += value;
    seen += 1;
  }
  return seen === 0 ? undefined : total;
}

/** Mean of an instant vector, or undefined when the query returned nothing. */
export function vectorMean(body: PromResult | undefined): number | undefined {
  const rows = body?.data?.result;
  if (!Array.isArray(rows) || rows.length === 0) return undefined;
  const values = rows
    .map(row => finite(row.value?.[1]))
    .filter((v): v is number => v !== undefined);
  if (values.length === 0) return undefined;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Count of series in an instant vector. Zero rows means zero series. */
export function vectorCount(body: PromResult | undefined): number | undefined {
  const rows = body?.data?.result;
  return Array.isArray(rows) ? rows.length : undefined;
}

// The DORA exporter emits a synthetic `service="all-services"` roll-up alongside
// the per-service rows. Averaging across both would count the aggregate twice,
// so every DORA query excludes it and takes the mean of the real services.
const EXCLUDE_ROLLUP = '{service!="all-services"}';

export async function collectPrometheus(
  ctx: CollectorContext,
): Promise<CollectorResult> {
  const base = proxyTarget(ctx.config, '/prometheus');
  if (!base) {
    return {
      samples: [],
      unavailable: {
        source: 'prometheus',
        reason: 'No proxy.endpoints./prometheus.target is configured.',
      },
    };
  }

  const observedAt = new Date().toISOString();
  const query = (q: string) =>
    getJson<PromResult>(
      `${base}/api/v1/query?query=${encodeURIComponent(q)}`,
    );

  const [
    deployFreq,
    leadTime,
    changeFailure,
    mttr,
    flakiness,
    testPass,
    testFail,
    budgetUtil,
    goldTier,
    scorecardTotal,
    mcpOk,
    mcpAll,
    prCycleTime,
    ciDuration,
    buildFailure,
    teamActualCost,
  ] = await Promise.all([
    query(`dora_deploy_frequency_per_day${EXCLUDE_ROLLUP}`),
    query(`dora_lead_time_minutes${EXCLUDE_ROLLUP}`),
    query(`dora_change_failure_rate_percent${EXCLUDE_ROLLUP}`),
    query(`dora_mttr_minutes${EXCLUDE_ROLLUP}`),
    query('idp_test_service_flakiness_ratio'),
    query('idp_test_pass_total'),
    query('idp_test_fail_total'),
    query('idp_team_budget_utilization_ratio'),
    query('idp_scorecard_tier_gold'),
    query('idp_scorecard_checks_passed'),
    query('mcp_tool_calls_total{outcome="success"}'),
    query('mcp_tool_calls_total'),
    // Developer Experience, pushed by the same DORA exporter CronJob. These
    // carry the synthetic all-services roll-up too, so they need the same
    // exclusion the dora_* queries use.
    query(`devex_pr_cycle_time_hours${EXCLUDE_ROLLUP}`),
    query(`devex_ci_duration_minutes${EXCLUDE_ROLLUP}`),
    query(`devex_build_failure_ratio${EXCLUDE_ROLLUP}`),
    // Needed only to decide whether budget utilisation means anything — see below.
    query('idp_team_actual_cost_usd_monthly'),
  ]);

  if (
    [deployFreq, leadTime, changeFailure, mttr].every(r => r === undefined)
  ) {
    // Not one DORA query answered — treat the source as down rather than
    // reporting a handful of half-collected metrics as if the rest were zero.
    return {
      samples: [],
      unavailable: {
        source: 'prometheus',
        reason: `Prometheus at ${base} did not answer.`,
      },
    };
  }

  const samples: MetricSample[] = [];
  const push = (metric: string, value: number | undefined) => {
    if (value === undefined) return;
    samples.push({ metric, value, source: 'prometheus', observedAt });
  };

  // Deploy frequency is meaningful at zero: a platform that is not deploying is
  // a real, reportable state.
  push('dora.deployFrequencyPerDay', vectorMean(deployFreq));

  // The other three are not. The DORA exporter publishes 0.0 for a repo with no
  // deployments rather than omitting the series, so a platform that has never
  // deployed reports change failure rate 0% and MTTR 0 minutes — which the
  // banded normalisers read as *elite*, scoring Reliability 100 on a platform
  // that has never shipped anything. Observed on a fresh local cluster
  // 2026-08-28: ten discovered repos, zero deploys, Reliability 100.
  //
  // Nothing failed and nothing was restored because nothing was deployed. That
  // is an absence of evidence, not a perfect record, so these are withheld —
  // the same rule the devex_* series follow at the exporter end.
  const deployTotal = vectorSum(deployFreq);
  const deployedInWindow = deployTotal !== undefined && deployTotal > 0;

  if (deployedInWindow) {
    push('dora.leadTimeMinutes', vectorMean(leadTime));
    push('dora.changeFailureRatePercent', vectorMean(changeFailure));
    push('dora.mttrMinutes', vectorMean(mttr));
  }

  push('test.flakinessRatio', vectorMean(flakiness));

  const passed = vectorSum(testPass);
  const failed = vectorSum(testFail);
  if (passed !== undefined && failed !== undefined) {
    push('test.passRate', safeRatio(passed, passed + failed));
  }

  // Budget utilisation is actual/budget, and the exporter publishes 0 for a team
  // with no attributed spend rather than omitting it. The inverse-linear
  // normaliser reads 0 as *perfectly under budget* and scores it 100, so a
  // platform where no workload carries a `team` label reports exemplary cost
  // discipline. Observed on a fresh local cluster 2026-08-28: eight teams, zero
  // attributed cost, FinOps 58 against a real efficiency of 15.6%.
  //
  // Same rule as change failure rate over zero deploys: a ratio whose numerator
  // was never measured is not a good ratio, it is an absent one.
  const attributedCost = vectorSum(teamActualCost);
  if (attributedCost !== undefined && attributedCost > 0) {
    push('finops.budgetUtilisationRatio', vectorMean(budgetUtil));
  }

  // The exporter omits a DevEx series entirely when nothing merged or nothing
  // ran, rather than pushing 0.0 — so an empty vector here means "not observed",
  // and vectorMean correctly returns undefined rather than a flattering zero.
  push('devex.prCycleTimeHours', vectorMean(prCycleTime));
  push('devex.ciDurationMinutes', vectorMean(ciDuration));
  push('devex.buildFailureRatio', vectorMean(buildFailure));

  // idp_scorecard_tier_gold is 1 per service that has reached Gold and 0
  // otherwise, so the ratio is the mean — but only when the scorecard exporter
  // has reported at all. An empty vector means no data, not zero adoption.
  const goldCount = vectorSum(goldTier);
  const serviceCount = vectorCount(scorecardTotal);
  if (goldCount !== undefined && serviceCount) {
    push('scorecard.goldTierRatio', safeRatio(goldCount, serviceCount));
  }

  const okCalls = vectorSum(mcpOk);
  const allCalls = vectorSum(mcpAll);
  if (okCalls !== undefined && allCalls !== undefined) {
    push('ai.mcpToolSuccessRatio', safeRatio(okCalls, allCalls));
  }

  return { samples };
}
