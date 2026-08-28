// Stands in for Prometheus and OpenCost during verification.
// Returns realistically-shaped bodies so the collectors' parsers are exercised
// against the real response shapes rather than against their own fixtures.
import { createServer } from 'node:http';

const vec = (...rows) => ({
  status: 'success',
  data: {
    resultType: 'vector',
    result: rows.map(([labels, value]) => ({
      metric: labels,
      value: [1756371600, String(value)],
    })),
  },
});

const SERIES = {
  // Two real services plus the synthetic roll-up the DORA exporter also emits.
  // If the collector fails to exclude all-services, the means below shift.
  dora_deploy_frequency_per_day: vec(
    [{ service: 'orders-api', team: 'payments' }, 2.4],
    [{ service: 'auth-service', team: 'platform' }, 1.1],
  ),
  dora_lead_time_minutes: vec(
    [{ service: 'orders-api' }, 45],
    [{ service: 'auth-service' }, 90],
  ),
  dora_change_failure_rate_percent: vec(
    [{ service: 'orders-api' }, 3],
    [{ service: 'auth-service' }, 6],
  ),
  dora_mttr_minutes: vec([{ service: 'orders-api' }, 35], [{ service: 'auth-service' }, 55]),
  idp_test_flakiness_ratio: vec([{ service: 'orders-api' }, 0.04]),
  idp_test_pass_total: vec([{ service: 'orders-api' }, 940]),
  idp_test_fail_total: vec([{ service: 'orders-api' }, 60]),
  idp_team_budget_utilization_ratio: vec([{ team: 'payments' }, 0.82]),
  idp_scorecard_tier_gold: vec([{ service: 'orders-api' }, 1], [{ service: 'auth-service' }, 0]),
  idp_scorecard_checks_passed: vec([{ service: 'orders-api' }, 11], [{ service: 'auth-service' }, 6]),
  // Phase 5 — Developer Experience, published by the same DORA exporter.
  devex_pr_cycle_time_hours: vec(
    [{ service: 'orders-api' }, 9.5],
    [{ service: 'auth-service' }, 30],
  ),
  devex_ci_duration_minutes: vec(
    [{ service: 'orders-api' }, 11],
    [{ service: 'auth-service' }, 19],
  ),
  devex_build_failure_ratio: vec(
    [{ service: 'orders-api' }, 0.06],
    [{ service: 'auth-service' }, 0.12],
  ),
  'mcp_tool_calls_total{outcome="success"}': vec([{ server: 'idp' }, 486]),
  mcp_tool_calls_total: vec([{ server: 'idp' }, 500]),
};

createServer((req, res) => {
  const url = new URL(req.url, 'http://stub');
  res.setHeader('content-type', 'application/json');

  if (url.pathname === '/api/v1/query') {
    const q = url.searchParams.get('query') ?? '';
    // Strip the label selector the collector appends to DORA queries.
    const bare = q.replace(/\{service!="all-services"\}$/, '');
    const body = SERIES[q] ?? SERIES[bare];
    console.log(`prom  ${body ? 'HIT ' : 'MISS'} ${q}`);
    res.end(JSON.stringify(body ?? vec()));
    return;
  }

  if (url.pathname === '/allocation/compute') {
    console.log('opencost HIT');
    res.end(
      JSON.stringify({
        data: [
          {
            services: { totalCost: 40.2, cpuCost: 22, ramCost: 15, pvCost: 3.2, totalEfficiency: 0.58 },
            monitoring: { totalCost: 12.5, cpuCost: 8, ramCost: 4, pvCost: 0.5, totalEfficiency: 0.31 },
          },
        ],
      }),
    );
    return;
  }

  console.log(`404 ${url.pathname}`);
  res.statusCode = 404;
  res.end('{}');
}).listen(9099, () => console.log('stub listening on 9099'));
