import { MetricSample } from '@internal/engineering-intelligence-core';
import { CollectorResult, getJson, safeRatio } from './source';

// Catalog collector — service and ownership shape, straight from the catalog API.
//
// Golden-path adoption is read from `backstage.io/source-template`, the
// annotation the scaffolder stamps on every entity it creates. That is real
// provenance rather than a proxy: an entity carrying it was demonstrably
// generated from a template, and one without it was not.
//
// Worth knowing when reading the number: the platform's own catalog entities are
// hand-written YAML under backstage/catalog/, so they legitimately carry no
// source-template and count against adoption. On a fresh install, before any
// service has been scaffolded, this metric is honestly near zero.

const SOURCE_TEMPLATE_ANNOTATION = 'backstage.io/source-template';

export interface CatalogEntity {
  kind?: string;
  metadata?: { name?: string; annotations?: Record<string, string> };
  spec?: { owner?: string };
}

/**
 * The Platform Health breakdown behind the Platform dimension's score.
 *
 * Reported, not scored. "642 services" is not better or worse than "300" — it
 * is context a reader needs to interpret the ratios, and inventing a scoring
 * curve for it would assert a judgement the platform has no basis for.
 */
export interface PlatformFacts {
  serviceCount: number;
  ownedCount: number;
  scaffoldedCount: number;
  /** Component count per source template, most used first. */
  templateUsage: { template: string; count: number }[];
  /** Named services with no golden-path provenance, capped for the response. */
  unscaffolded: string[];
}

/** Cap on the named-services list, so one enormous catalog cannot bloat the API. */
const MAX_NAMED = 50;

function templateName(ref: string): string {
  // `template:default/go-service` → `go-service`. Falls back to the raw ref so
  // an unexpected shape is still visible rather than silently blanked.
  const match = /(?:^|\/)([^/]+)$/.exec(ref);
  return match ? match[1] : ref;
}

export function platformFacts(components: CatalogEntity[]): PlatformFacts {
  const byTemplate = new Map<string, number>();
  const unscaffolded: string[] = [];
  let owned = 0;
  let scaffolded = 0;

  for (const entity of components) {
    if (
      typeof entity.spec?.owner === 'string' &&
      entity.spec.owner.trim() !== ''
    ) {
      owned += 1;
    }
    const source = entity.metadata?.annotations?.[SOURCE_TEMPLATE_ANNOTATION];
    if (source) {
      scaffolded += 1;
      const name = templateName(source);
      byTemplate.set(name, (byTemplate.get(name) ?? 0) + 1);
    } else if (entity.metadata?.name) {
      unscaffolded.push(entity.metadata.name);
    }
  }

  return {
    serviceCount: components.length,
    ownedCount: owned,
    scaffoldedCount: scaffolded,
    templateUsage: [...byTemplate.entries()]
      .map(([template, count]) => ({ template, count }))
      .sort(
        (a, b) => b.count - a.count || a.template.localeCompare(b.template),
      ),
    // Sorted so the list is stable between refreshes; a set that reshuffles on
    // every collection is unreadable in a UI.
    unscaffolded: unscaffolded.sort().slice(0, MAX_NAMED),
  };
}

/** Derive the catalog signals from a set of entities. Pure, so it is testable. */
export function catalogSamples(
  components: CatalogEntity[],
  observedAt: string,
): MetricSample[] {
  const samples: MetricSample[] = [];
  const push = (metric: string, value: number | undefined) => {
    if (value === undefined) return;
    samples.push({ metric, value, source: 'catalog', observedAt });
  };

  const total = components.length;
  const owned = components.filter(
    e => typeof e.spec?.owner === 'string' && e.spec.owner.trim() !== '',
  ).length;
  const scaffolded = components.filter(
    e => !!e.metadata?.annotations?.[SOURCE_TEMPLATE_ANNOTATION],
  ).length;

  push('catalog.ownershipCoverage', safeRatio(owned, total));
  push('catalog.goldenPathAdoption', safeRatio(scaffolded, total));

  return samples;
}

export interface CatalogAccess {
  baseUrl(): Promise<string>;
  token(): Promise<string>;
}

export type CatalogCollectorResult = CollectorResult & {
  facts?: PlatformFacts;
  /** Component name → owner, the join key AI cost attribution needs. */
  owners?: Record<string, string>;
};

/** Entity name to owner, for joining a workload to the team that owns it. */
export function ownerMap(components: CatalogEntity[]): Record<string, string> {
  const owners: Record<string, string> = {};
  for (const entity of components) {
    const name = entity.metadata?.name;
    const owner = entity.spec?.owner;
    if (!name || typeof owner !== 'string' || owner.trim() === '') continue;
    // Owners arrive as `group:default/team-a` or bare `team-a`; the short form is
    // what a reader recognises and what the FinOps team labels already use.
    owners[name] = owner.includes('/') ? owner.split('/').pop()! : owner;
  }
  return owners;
}

export async function collectCatalog(
  access: CatalogAccess,
): Promise<CatalogCollectorResult> {
  const observedAt = new Date().toISOString();

  let base: string;
  let token: string;
  try {
    base = await access.baseUrl();
    token = await access.token();
  } catch (error) {
    return {
      samples: [],
      unavailable: {
        source: 'catalog',
        reason: `Could not obtain catalog credentials: ${error}`,
      },
    };
  }

  // Ask only for the fields the signals need. The catalog holds several hundred
  // entities once GitHub discovery has run, and pulling whole entity bodies to
  // read two fields is wasteful on every scheduled refresh.
  const fields = [
    'kind',
    'metadata.name',
    'metadata.annotations',
    'spec.owner',
  ];
  const url =
    `${base}/entities?filter=kind=component` +
    `&fields=${encodeURIComponent(fields.join(','))}` +
    `&limit=10000`;

  const body = await getJson<CatalogEntity[]>(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!Array.isArray(body)) {
    return {
      samples: [],
      unavailable: {
        source: 'catalog',
        reason: `Catalog at ${base} did not answer with an entity list.`,
      },
    };
  }

  if (body.length === 0) {
    // An empty catalog is not a catalog of unowned services. Reporting 0%
    // ownership here would be the single most misleading number this collector
    // could produce, so it reports nothing instead.
    return {
      samples: [],
      unavailable: {
        source: 'catalog',
        reason: 'The catalog holds no Components yet.',
      },
    };
  }

  return {
    samples: catalogSamples(body, observedAt),
    facts: platformFacts(body),
    owners: ownerMap(body),
  };
}
