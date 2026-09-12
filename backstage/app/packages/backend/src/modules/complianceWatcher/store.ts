// Fact-state store for the compliance watcher.
//
// Persists the last-seen idp-entity-facts booleans per entity so a restart
// does not replay every fact as a fresh regression, and so a regression is
// only reported once per true->false transition (not on every scheduler
// tick while the check stays failing). Same CREATE TABLE IF NOT EXISTS +
// own-Postgres-database shape as idpLearningCenter.ts / idpRagSearch.ts /
// engineeringIntelligence/store.ts.

export interface Knexish {
  raw(sql: string): Promise<unknown>;
  (table: string): any;
}

export async function ensureSchema(db: Knexish): Promise<void> {
  await db.raw(`
    CREATE TABLE IF NOT EXISTS compliance_fact_state (
      entity_ref TEXT        PRIMARY KEY,
      facts      JSONB       NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

/** Previously recorded facts for an entity, or undefined the first time it's seen. */
export async function getState(
  db: Knexish,
  entityRef: string,
): Promise<Record<string, boolean> | undefined> {
  const rows = await db('compliance_fact_state')
    .where({ entity_ref: entityRef })
    .select('facts');
  const row = rows?.[0];
  if (!row) return undefined;
  return typeof row.facts === 'string' ? JSON.parse(row.facts) : row.facts;
}

export async function saveState(
  db: Knexish,
  entityRef: string,
  facts: Record<string, boolean>,
): Promise<void> {
  await db('compliance_fact_state')
    .insert({ entity_ref: entityRef, facts: JSON.stringify(facts), updated_at: new Date() })
    .onConflict('entity_ref')
    .merge({ facts: JSON.stringify(facts), updated_at: new Date() });
}

/**
 * Fact keys that were `true` in `previous` and are `false` (or absent) in
 * `current`. Absent-in-previous is not a regression — that's a fact
 * appearing for the first time, not one going bad.
 */
export function detectRegressions(
  previous: Record<string, boolean> | undefined,
  current: Record<string, boolean>,
): string[] {
  if (!previous) return [];
  return Object.keys(previous).filter(
    key => previous[key] === true && current[key] !== true,
  );
}
