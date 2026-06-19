import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fetch, { RequestInit } from 'node-fetch';
import { Counter, Histogram } from 'prom-client';

const OPENCOST_URL = process.env.OPENCOST_URL ?? 'http://opencost.opencost.svc.cluster.local:9003';
const PROMETHEUS_URL = process.env.PROMETHEUS_URL ?? 'http://prometheus-kube-prometheus-prometheus.monitoring:9090';
const HTTP_TIMEOUT_MS = parseInt(process.env.HTTP_TIMEOUT_MS ?? '15000', 10);
export const SERVER_NAME = 'cost-mcp-server';

// Safe label value: alphanumeric, hyphens, and underscores only.
const LABEL_RE = /^[a-zA-Z0-9_-]{1,64}$/;
export const safeLabel = z.string().regex(LABEL_RE, 'must be 1-64 chars: letters, digits, hyphens, underscores');
export const safeWindow = z.enum(['today', '7d', '30d', 'month']).default('30d');

export const toolCalls = new Counter({
  name: 'mcp_tool_calls_total',
  help: 'Total MCP tool calls',
  labelNames: ['server', 'tool', 'outcome'],
});
export const toolDuration = new Histogram({
  name: 'mcp_tool_duration_seconds',
  help: 'MCP tool call duration',
  labelNames: ['server', 'tool'],
});
export const agentToolCalls = new Counter({
  name: 'mcp_agent_tool_calls_total',
  help: 'MCP tool calls by agent',
  labelNames: ['server', 'tool', 'agent'],
});

export async function fetchWithTimeout(url: string, init: RequestInit = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function queryPrometheus(query: string): Promise<number | null> {
  const url = `${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(query)}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) return null;
  const data = await res.json() as { data: { result: Array<{ value: [number, string] }> } };
  const result = data?.data?.result?.[0];
  return result ? parseFloat(result.value[1]) : null;
}

export function createServer(agentId: string = 'unknown') {
  const server = new McpServer({ name: SERVER_NAME, version: '0.1.0' });

  server.tool(
    'get_namespace_cost',
    'Get the actual compute cost (CPU + memory) for a Kubernetes namespace over a time window',
    {
      namespace: safeLabel.describe('Kubernetes namespace name'),
      window: safeWindow.describe('Time window: "today", "7d", "30d", "month" (default "30d")'),
    },
    async ({ namespace, window }) => {
      const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'get_namespace_cost' });
      agentToolCalls.inc({ server: SERVER_NAME, tool: 'get_namespace_cost', agent: agentId });
      let outcome = 'success';
      try {
        const url = `${OPENCOST_URL}/allocation/compute?window=${encodeURIComponent(window)}&aggregate=namespace&accumulate=true`;
        const res = await fetchWithTimeout(url);
        if (!res.ok) throw new Error(`OpenCost error ${res.status}: ${await res.text()}`);
        const data = await res.json() as { data: Array<Record<string, { totalCost: number; cpuCost: number; ramCost: number; networkCost: number; storageUsageCost: number; minutes: number }>> };
        const sets = data.data ?? [];
        const entry = sets.length > 0 ? sets[0][namespace] ?? sets[0][Object.keys(sets[0])[0]] : null;
        if (!entry) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ namespace, window, message: 'No cost data found — namespace may be new or OpenCost may not have scraped it yet' }) }] };
        }
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              namespace,
              window,
              total_cost_usd: Math.round(entry.totalCost * 100) / 100,
              cpu_cost_usd: Math.round(entry.cpuCost * 100) / 100,
              memory_cost_usd: Math.round(entry.ramCost * 100) / 100,
              network_cost_usd: Math.round(entry.networkCost * 100) / 100,
              storage_cost_usd: Math.round(entry.storageUsageCost * 100) / 100,
              hours_sampled: Math.round(entry.minutes / 60),
            }),
          }],
        };
      } catch (err) {
        outcome = 'error';
        throw err;
      } finally {
        end();
        toolCalls.inc({ server: SERVER_NAME, tool: 'get_namespace_cost', outcome });
      }
    },
  );

  server.tool(
    'get_team_spend',
    'Get the monthly spend and budget utilisation for a platform team using Prometheus idp_team_* metrics pushed by the tech-insights-exporter',
    {
      team: safeLabel.describe('Team name as used in catalog entity annotations, e.g. "team-platform"'),
    },
    async ({ team }) => {
      const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'get_team_spend' });
      agentToolCalls.inc({ server: SERVER_NAME, tool: 'get_team_spend', agent: agentId });
      let outcome = 'success';
      try {
        const [actualCost, budgetUtilization, budgetLimit] = await Promise.all([
          queryPrometheus(`idp_team_actual_cost_usd_monthly{team="${team}"}`),
          queryPrometheus(`idp_team_budget_utilization_ratio{team="${team}"}`),
          queryPrometheus(`idp_team_budget_usd_monthly{team="${team}"}`),
        ]);
        if (actualCost === null) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ team, message: 'No cost metrics found. Ensure idp_team_actual_cost_usd_monthly is being pushed by the tech-insights-exporter.' }) }] };
        }
        const utilizationPct = budgetUtilization !== null ? Math.round(budgetUtilization * 100) : null;
        const status = utilizationPct !== null
          ? utilizationPct >= 90 ? 'OVER_BUDGET' : utilizationPct >= 75 ? 'WARNING' : 'OK'
          : 'UNKNOWN';
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              team,
              actual_cost_usd: Math.round(actualCost * 100) / 100,
              budget_limit_usd: budgetLimit !== null ? Math.round(budgetLimit * 100) / 100 : null,
              utilization_pct: utilizationPct,
              status,
            }),
          }],
        };
      } catch (err) {
        outcome = 'error';
        throw err;
      } finally {
        end();
        toolCalls.inc({ server: SERVER_NAME, tool: 'get_team_spend', outcome });
      }
    },
  );

  server.tool(
    'list_budget_overruns',
    'List all teams whose budget utilisation is above a threshold',
    {
      threshold_pct: z.number().min(0).max(100).optional().describe('Alert threshold as a percentage (default 80)'),
    },
    async ({ threshold_pct = 80 }) => {
      const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'list_budget_overruns' });
      agentToolCalls.inc({ server: SERVER_NAME, tool: 'list_budget_overruns', agent: agentId });
      let outcome = 'success';
      try {
        const threshold = threshold_pct / 100;
        const url = `${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(`idp_team_budget_utilization_ratio > ${threshold}`)}`;
        const res = await fetchWithTimeout(url);
        if (!res.ok) throw new Error(`Prometheus error ${res.status}: ${await res.text()}`);
        const data = await res.json() as { data: { result: Array<{ metric: { team: string }; value: [number, string] }> } };
        const overruns = (data.data?.result ?? []).map(r => ({
          team: r.metric.team,
          utilization_pct: Math.round(parseFloat(r.value[1]) * 100),
        })).sort((a, b) => b.utilization_pct - a.utilization_pct);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              threshold_pct,
              overrun_count: overruns.length,
              teams: overruns,
            }),
          }],
        };
      } catch (err) {
        outcome = 'error';
        throw err;
      } finally {
        end();
        toolCalls.inc({ server: SERVER_NAME, tool: 'list_budget_overruns', outcome });
      }
    },
  );

  server.tool(
    'get_rightsizing_recommendations',
    'Get CPU and memory rightsizing recommendations from OpenCost for over- or under-provisioned workloads',
    {
      namespace: safeLabel.optional().describe('Limit to a specific namespace (omit for all)'),
      window: safeWindow.describe('Observation window for usage data: "7d" or "30d" (default "7d")'),
    },
    async ({ namespace, window }) => {
      const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'get_rightsizing_recommendations' });
      agentToolCalls.inc({ server: SERVER_NAME, tool: 'get_rightsizing_recommendations', agent: agentId });
      let outcome = 'success';
      try {
        const nsParam = namespace ? `&filterNamespaces=${encodeURIComponent(namespace)}` : '';
        const url = `${OPENCOST_URL}/model/recommendations/compute?window=${encodeURIComponent(window)}${nsParam}`;
        const res = await fetchWithTimeout(url);
        if (!res.ok) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                window,
                namespace: namespace ?? 'all',
                message: 'Rightsizing recommendations are not available — this OpenCost OSS deployment does not expose a /model/recommendations/compute endpoint (it is a Kubecost Enterprise feature). Use get_namespace_cost for cost breakdowns instead.',
              }),
            }],
          };
        }
        const data = await res.json() as {
          recommendations?: Array<{
            namespace: string;
            controllerName: string;
            containerName: string;
            currentCPUReq: number;
            recommendedCPUReq: number;
            currentRAMReq: number;
            recommendedRAMReq: number;
            monthlySavings: number;
          }>;
        };
        const recs = (data.recommendations ?? [])
          .filter(r => r.monthlySavings > 0.5)
          .sort((a, b) => b.monthlySavings - a.monthlySavings)
          .slice(0, 20)
          .map(r => ({
            namespace: r.namespace,
            workload: r.controllerName,
            container: r.containerName,
            current_cpu_req: r.currentCPUReq,
            recommended_cpu_req: r.recommendedCPUReq,
            current_mem_req_mi: Math.round(r.currentRAMReq / (1024 * 1024)),
            recommended_mem_req_mi: Math.round(r.recommendedRAMReq / (1024 * 1024)),
            monthly_savings_usd: Math.round(r.monthlySavings * 100) / 100,
          }));
        const totalSavings = recs.reduce((s, r) => s + r.monthly_savings_usd, 0);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              window,
              namespace: namespace ?? 'all',
              total_recommendations: recs.length,
              total_potential_savings_usd: Math.round(totalSavings * 100) / 100,
              recommendations: recs,
            }),
          }],
        };
      } catch (err) {
        outcome = 'error';
        throw err;
      } finally {
        end();
        toolCalls.inc({ server: SERVER_NAME, tool: 'get_rightsizing_recommendations', outcome });
      }
    },
  );

  server.tool(
    'forecast_budget',
    'Forecast end-of-month spend for a team based on current burn rate',
    {
      team: safeLabel.describe('Team name as used in catalog entity annotations'),
    },
    async ({ team }) => {
      const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'forecast_budget' });
      agentToolCalls.inc({ server: SERVER_NAME, tool: 'forecast_budget', agent: agentId });
      let outcome = 'success';
      try {
        const now = new Date();
        const dayOfMonth = now.getDate();
        const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

        const [actualCost, budgetLimit] = await Promise.all([
          queryPrometheus(`idp_team_actual_cost_usd_monthly{team="${team}"}`),
          queryPrometheus(`idp_team_budget_usd_monthly{team="${team}"}`),
        ]);

        if (actualCost === null) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ team, message: 'No cost metrics found for this team.' }) }] };
        }

        const dailyBurnRate = actualCost / dayOfMonth;
        const forecastEom = dailyBurnRate * daysInMonth;
        const remainingBudget = budgetLimit !== null ? budgetLimit - forecastEom : null;
        const forecastUtilization = budgetLimit !== null ? Math.round((forecastEom / budgetLimit) * 100) : null;

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              team,
              day_of_month: dayOfMonth,
              days_in_month: daysInMonth,
              actual_spend_to_date_usd: Math.round(actualCost * 100) / 100,
              daily_burn_rate_usd: Math.round(dailyBurnRate * 100) / 100,
              forecast_eom_spend_usd: Math.round(forecastEom * 100) / 100,
              budget_limit_usd: budgetLimit !== null ? Math.round(budgetLimit * 100) / 100 : null,
              forecast_remaining_budget_usd: remainingBudget !== null ? Math.round(remainingBudget * 100) / 100 : null,
              forecast_utilization_pct: forecastUtilization,
              forecast_status: forecastUtilization !== null
                ? forecastUtilization >= 100 ? 'OVER_BUDGET' : forecastUtilization >= 90 ? 'AT_RISK' : 'ON_TRACK'
                : 'UNKNOWN',
            }),
          }],
        };
      } catch (err) {
        outcome = 'error';
        throw err;
      } finally {
        end();
        toolCalls.inc({ server: SERVER_NAME, tool: 'forecast_budget', outcome });
      }
    },
  );

  return server;
}
