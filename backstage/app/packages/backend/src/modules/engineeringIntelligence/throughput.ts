import {
  Core4TeamInput,
  MIN_RESPONSES,
  MetricSample,
} from '@internal/engineering-intelligence-core';
import { CollectorContext, CollectorResult, finite, getJson, proxyTarget } from './source';
import { PromResult } from './prometheus';

// Throughput collector — the DX Core 4 Speed key metric, diffs per engineer.
//
// The exporter counts merged PRs per repo (`devex_prs_merged_weekly`); the
// catalog knows who owns each repo and who is in each team. Joining the two
// here, rather than in the exporter, keeps headcount out of a Pushgateway
// gauge and lets the same floor that protects survey answers protect this.
//
// What it deliberately does not do: divide anything by one person. A team below
// the floor gets no per-engineer figure at all, and the organisation-wide
// figure is withheld too until enough engineers are behind it.

export interface CatalogRef {
  kind?: string;
  metadata?: { name?: string };
  spec?: { owner?: string };
  relations?: { type?: string; targetRef?: string }[];
}

export interface ThroughputAccess {
  baseUrl(): Promise<string>;
  token(): Promise<string>;
}

export type ThroughputResult = CollectorResult & { teams?: Core4TeamInput[] };

const shortName = (ref: string) => (ref.includes('/') ? ref.split('/').pop()! : ref);

/** Merged PRs per service, from the exporter's per-service series. */
export function prsByService(body: PromResult | undefined): Map<string, number> | undefined {
  const rows = body?.data?.result;
  if (!Array.isArray(rows) || rows.length === 0) return undefined;
  const out = new Map<string, number>();
  for (const row of rows) {
    const service = row.metric?.service;
    const value = finite(row.value?.[1]);
    if (!service || value === undefined) continue;
    out.set(service, value);
  }
  return out.size > 0 ? out : undefined;
}

/**
 * Join merged-PR counts to owning teams and their headcount. Pure, so the
 * arithmetic and the floor are testable without a catalog or Prometheus.
 */
export function throughput(
  prs: Map<string, number>,
  components: CatalogRef[],
  groups: CatalogRef[],
  observedAt: string,
  minCohort: number = MIN_RESPONSES,
): { samples: MetricSample[]; teams: Core4TeamInput[] } {
  const members = new Map<string, Set<string>>();
  for (const group of groups) {
    const name = group.metadata?.name;
    if (!name) continue;
    const refs = (group.relations ?? [])
      .filter(r => r.type === 'hasMember' && r.targetRef)
      .map(r => r.targetRef!);
    members.set(name, new Set(refs));
  }

  const prsByTeam = new Map<string, number>();
  for (const component of components) {
    const name = component.metadata?.name;
    const owner = component.spec?.owner;
    if (!name || !owner || !prs.has(name)) continue;
    const team = shortName(owner);
    // A service owned by a group with no members has no denominator; counting
    // its PRs anyway would inflate everyone else's rate.
    if (!members.get(team)?.size) continue;
    prsByTeam.set(team, (prsByTeam.get(team) ?? 0) + prs.get(name)!);
  }

  const teams: Core4TeamInput[] = [...prsByTeam.entries()].map(([team, merged]) => ({
    team,
    engineers: members.get(team)!.size,
    mergedPrsWeekly: merged,
  }));

  // Distinct people, not summed team sizes — someone in two teams is one engineer.
  const engineers = new Set<string>();
  for (const team of prsByTeam.keys()) members.get(team)!.forEach(m => engineers.add(m));
  const total = [...prsByTeam.values()].reduce((a, b) => a + b, 0);

  const samples: MetricSample[] =
    engineers.size >= minCohort
      ? [
          {
            metric: 'core4.diffsPerEngineerWeekly',
            value: Math.round((total / engineers.size) * 100) / 100,
            source: 'prometheus+catalog',
            observedAt,
          },
        ]
      : [];
  return { samples, teams };
}

export async function collectThroughput(
  ctx: CollectorContext,
  catalog: ThroughputAccess,
): Promise<ThroughputResult> {
  const unavailable = (reason: string): ThroughputResult => ({
    samples: [],
    unavailable: { source: 'throughput', reason },
  });

  const prom = proxyTarget(ctx.config, '/prometheus');
  if (!prom) return unavailable('No proxy.endpoints./prometheus.target is configured.');

  const prs = prsByService(
    await getJson<PromResult>(
      `${prom}/api/v1/query?query=${encodeURIComponent('devex_prs_merged_weekly{service!="all-services"}')}`,
    ),
  );
  if (!prs) return unavailable('No devex_prs_merged_weekly series yet — the DORA exporter has not run since it gained them.');

  let base: string;
  let token: string;
  try {
    base = await catalog.baseUrl();
    token = await catalog.token();
  } catch (error) {
    return unavailable(`Could not obtain catalog credentials: ${error}`);
  }
  const headers = { Authorization: `Bearer ${token}` };
  const [components, groups] = await Promise.all([
    getJson<CatalogRef[]>(
      `${base}/entities?filter=kind=component&fields=${encodeURIComponent('metadata.name,spec.owner')}&limit=10000`,
      { headers },
    ),
    getJson<CatalogRef[]>(
      `${base}/entities?filter=kind=group&fields=${encodeURIComponent('metadata.name,relations')}&limit=10000`,
      { headers },
    ),
  ]);
  if (!Array.isArray(components) || !Array.isArray(groups)) {
    return unavailable(`Catalog at ${base} did not answer with entity lists.`);
  }

  return throughput(prs, components, groups, new Date().toISOString());
}
