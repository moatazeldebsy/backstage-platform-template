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

export async function collectCatalog(
  access: CatalogAccess,
): Promise<CollectorResult> {
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
  const fields = ['kind', 'metadata.name', 'metadata.annotations', 'spec.owner'];
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

  return { samples: catalogSamples(body, observedAt) };
}
