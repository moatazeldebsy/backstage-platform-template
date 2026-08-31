// Multi-tenancy foundation — phase 12.
//
// The open-source platform is single-tenant and stays fully usable that way.
// What this adds is a name for the thing a hosted service would need to
// separate, so adopting one later is not a fork.
//
// The rule that keeps that honest: **`DEFAULT_ORGANISATION` is a real
// organisation, not a null.** Single-tenant is the one-organisation case of the
// general model rather than a special path beside it, so there is no
// second code path to keep working and no "if multi-tenant" branch to get wrong.
// A stored row written today carries the default id and needs no migration if a
// second organisation ever appears.
//
// No artificial limits are introduced. Nothing here gates a feature on tenancy.

import { DimensionId } from './model';

/**
 * The organisation every single-tenant install belongs to.
 *
 * Chosen to be stable and obviously not a customer identifier, so a row carrying
 * it is unambiguous years later.
 */
export const DEFAULT_ORGANISATION = 'default';

export interface Organisation {
  id: string;
  displayName: string;
}

/** The hierarchy a hosted deployment separates on. */
export interface TenantScope {
  organisationId: string;
  /** Absent means organisation-wide. */
  teamId?: string;
  /** Absent means all services in scope. */
  serviceRef?: string;
}

export function defaultScope(): TenantScope {
  return { organisationId: DEFAULT_ORGANISATION };
}

/**
 * Whether a scope is the plain single-tenant one.
 *
 * Used to keep single-tenant behaviour exactly as it was: no filtering, no
 * scope column in a query, no per-organisation cache key.
 */
export function isSingleTenant(scope: TenantScope): boolean {
  return (
    scope.organisationId === DEFAULT_ORGANISATION &&
    scope.teamId === undefined &&
    scope.serviceRef === undefined
  );
}

/**
 * A stable key for anything stored or cached per scope.
 *
 * Ordered organisation → team → service so keys sort into their hierarchy, and
 * unset levels are omitted rather than rendered as `undefined` — a key with a
 * literal "undefined" in it is the kind of thing that works until someone reads
 * the table.
 */
export function scopeKey(scope: TenantScope): string {
  return [scope.organisationId, scope.teamId, scope.serviceRef]
    .filter((part): part is string => !!part)
    .join('/');
}

/**
 * Parse a scope from request parameters, defaulting to single-tenant.
 *
 * Anything unrecognised falls back to the default organisation rather than
 * throwing: on a single-tenant install a stray `?organisationId=` in a URL
 * should be ignored, not turned into an error page.
 */
export function scopeFrom(params: {
  organisationId?: unknown;
  teamId?: unknown;
  serviceRef?: unknown;
}): TenantScope {
  const str = (v: unknown) =>
    typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;

  return {
    organisationId: str(params.organisationId) ?? DEFAULT_ORGANISATION,
    teamId: str(params.teamId),
    serviceRef: str(params.serviceRef),
  };
}

/**
 * What a hosted service would hold per organisation.
 *
 * Written as a type rather than a table so the shape is reviewable before
 * anything commits to storing it. Scores, recommendations and insights are
 * already produced per collection; tenancy only changes what they are filed
 * under.
 */
export interface OrganisationRecord {
  organisation: Organisation;
  teams: string[];
  services: string[];
  /** Latest scores, by dimension. */
  scores: Partial<Record<DimensionId, number | null>>;
  recommendationIds: string[];
}
