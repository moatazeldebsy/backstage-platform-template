// AI / LLM cost intelligence — phase 8.
//
// The roadmap recorded this as blocked: "Langfuse traces carry no catalog or
// team attribution — the join key has to be added at the emitting end." That was
// half right. There is no *explicit* key, but there is a derivable one, and it
// is already being written today:
//
//   KAgent agent turns   `/a2a/kagent/platform-assistant`  → platform-assistant
//   MCP tool calls       `idp-mcp-server.catalog_search`   → idp-mcp-server
//
// Both of those names are catalog Components, so a trace can be joined to an
// owner and therefore a team. What makes this honest rather than clever is that
// the join is by **naming convention, not a contract**: a workload whose trace
// name does not match a catalog entity cannot be attributed, and its spend is
// reported as an explicit unattributed remainder rather than dropped or spread
// across the teams that happen to be known.
//
// Spend is reported, never scored. A team spending more is not doing worse — the
// scored signal out of all this is `ai.costAttributedRatio`, which measures how
// much of the bill you can actually explain.

/** One trace's cost, as Langfuse reports it. */
export interface TraceCost {
  /** Langfuse trace name, e.g. `/a2a/kagent/platform-assistant`. */
  name: string;
  costUsd: number;
  observedAt: string;
}

/** Per-model usage, from Langfuse's daily metrics rollup. */
export interface ModelCost {
  model: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export interface CostBucket {
  key: string;
  costUsd: number;
  traces: number;
}

export interface AiCostReport {
  generatedAt: string;
  /** Days the figures cover, so a reader knows what "total" means. */
  windowDays: number;
  totalUsd: number;
  /** Spend that could be joined to a catalog entity. */
  attributedUsd: number;
  /** Spend whose trace name matched no catalog entity. Never redistributed. */
  unattributedUsd: number;
  /** 0–1. The scored signal: how much of the bill you can explain. */
  attributedRatio: number | null;
  byWorkload: CostBucket[];
  byTeam: CostBucket[];
  byModel: ModelCost[];
  /** Trace names that matched nothing, so the convention can be fixed. */
  unmatchedNames: string[];
}

/**
 * The workload a trace belongs to, derived from its name.
 *
 * Two shapes, because two producers write them. Returns undefined rather than
 * guessing when neither matches — an unrecognised name must stay unattributed,
 * not be forced into a bucket.
 */
export function deriveWorkload(traceName: string): string | undefined {
  // KAgent A2A turns: /a2a/<namespace>/<agent>
  const a2a = /\/a2a\/[^/]+\/([^/?#]+)/.exec(traceName);
  if (a2a) return a2a[1];

  // MCP tool calls: <server>.<tool>
  const mcp = /^([a-z0-9][a-z0-9-]*)\.[A-Za-z0-9_]+$/.exec(traceName.trim());
  if (mcp) return mcp[1];

  return undefined;
}

function round(value: number, places = 4): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

/**
 * Aggregate trace costs into workload, team and model views.
 *
 * `owners` maps a catalog entity name to its owner. A workload absent from that
 * map is counted as unattributed even though its name parsed — parsing a name is
 * not the same as knowing who owns it, and inventing a team here would be the
 * whole failure this layer exists to avoid.
 */
export function summariseAiCost(
  traces: TraceCost[],
  owners: Record<string, string>,
  models: ModelCost[] = [],
  options: { generatedAt?: string; windowDays?: number } = {},
): AiCostReport {
  const byWorkload = new Map<string, CostBucket>();
  const byTeam = new Map<string, CostBucket>();
  const unmatched = new Set<string>();

  let total = 0;
  let attributed = 0;

  for (const trace of traces) {
    const cost = Number.isFinite(trace.costUsd) ? trace.costUsd : 0;
    total += cost;

    const workload = deriveWorkload(trace.name);
    const owner = workload ? owners[workload] : undefined;

    if (!workload || !owner) {
      unmatched.add(trace.name);
      continue;
    }

    attributed += cost;

    const w = byWorkload.get(workload) ?? {
      key: workload,
      costUsd: 0,
      traces: 0,
    };
    w.costUsd += cost;
    w.traces += 1;
    byWorkload.set(workload, w);

    const t = byTeam.get(owner) ?? { key: owner, costUsd: 0, traces: 0 };
    t.costUsd += cost;
    t.traces += 1;
    byTeam.set(owner, t);
  }

  const sortByCost = (a: CostBucket, b: CostBucket) => b.costUsd - a.costUsd;
  const tidy = (b: CostBucket) => ({ ...b, costUsd: round(b.costUsd) });

  return {
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    windowDays: options.windowDays ?? 7,
    totalUsd: round(total),
    attributedUsd: round(attributed),
    unattributedUsd: round(total - attributed),
    // Null rather than 1 when nothing was spent: a platform with no AI traffic
    // has not attributed its spend perfectly, it has no spend to attribute.
    attributedRatio: total > 0 ? round(attributed / total, 3) : null,
    byWorkload: [...byWorkload.values()].sort(sortByCost).map(tidy),
    byTeam: [...byTeam.values()].sort(sortByCost).map(tidy),
    byModel: [...models]
      .sort((a, b) => b.costUsd - a.costUsd)
      .map(m => ({ ...m, costUsd: round(m.costUsd) })),
    unmatchedNames: [...unmatched].sort().slice(0, 50),
  };
}

export interface CostRecommendation {
  id: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  action: string;
  /** The figure behind it, so the advice is checkable. */
  evidence: string;
}

/**
 * Recommendations derived strictly from what was measured.
 *
 * Note what is *not* here: "move low-complexity summarisation to a cheaper
 * model". That needs to know a workload's complexity, and nothing in this
 * platform does. Naming a saving figure from a guess about complexity would be
 * exactly the fabrication this layer refuses elsewhere, so the recommendations
 * below stick to concentration and attribution — both of which are facts on the
 * page above them.
 */
export function costRecommendations(
  report: AiCostReport,
): CostRecommendation[] {
  const out: CostRecommendation[] = [];

  if (report.attributedRatio !== null && report.attributedRatio < 0.8) {
    out.push({
      id: 'ai.cost.unattributed',
      severity: 'warning',
      title: 'A large share of AI spend cannot be attributed to a team',
      action:
        'Align agent and MCP trace names with their catalog entity names, or register the missing entities — until then this spend has no owner.',
      evidence: `$${report.unattributedUsd} of $${report.totalUsd} unattributed across ${report.unmatchedNames.length} trace name(s)`,
    });
  }

  const top = report.byModel[0];
  if (top && report.totalUsd > 0) {
    const share = top.costUsd / report.totalUsd;
    if (share > 0.7) {
      out.push({
        id: 'ai.cost.modelConcentration',
        severity: 'info',
        title: `${Math.round(share * 100)}% of AI spend is on one model`,
        action: `Review whether every workload on ${top.model} needs it — this is where a cheaper model would have the most effect, if any workload can tolerate one.`,
        evidence: `$${top.costUsd} of $${report.totalUsd} on ${top.model}`,
      });
    }
  }

  return out;
}
