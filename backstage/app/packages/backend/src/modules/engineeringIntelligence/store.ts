import { HealthReport } from '@internal/engineering-intelligence-core';

// Snapshot store.
//
// This exists because the platform has nowhere else to keep a trend. Prometheus
// retention is 6 hours locally and 30 days on AWS, there is no Thanos/Mimir or
// AMP remote-write, and every custom metric arrives as a last-write-wins
// Pushgateway gauge. Quarter-over-quarter movement — the thing an executive
// report is actually about — cannot be reconstructed after the fact, so it has
// to be recorded as it happens, from the first refresh.
//
// Schema is created inline with CREATE TABLE IF NOT EXISTS, matching
// idpLearningCenter.ts and idpRagSearch.ts. Backstage's PluginDatabaseManager
// provisions `backstage_plugin_engineering-intelligence` on first getClient().
//
// Postgres is assumed — BIGSERIAL, TIMESTAMPTZ and JSONB are Postgres types, and
// the DDL below will not run on the in-memory SQLite that bare `yarn start` uses
// from the base app-config.yaml. That is the same assumption idpRagSearch.ts
// already makes (it opens with `CREATE EXTENSION vector`), and both the local
// docker-compose stack and AWS run Postgres.

export interface Snapshot {
  capturedAt: string;
  report: HealthReport;
}

export interface Knexish {
  raw(sql: string): Promise<unknown>;
  (table: string): any;
}

export async function ensureSchema(db: Knexish): Promise<void> {
  await db.raw(`
    CREATE TABLE IF NOT EXISTS ei_snapshots (
      id          BIGSERIAL   PRIMARY KEY,
      captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      report      JSONB       NOT NULL
    )
  `);
  await db.raw(`
    CREATE INDEX IF NOT EXISTS ei_snapshots_captured_at_idx
      ON ei_snapshots (captured_at DESC)
  `);
}

export async function saveSnapshot(
  db: Knexish,
  report: HealthReport,
): Promise<void> {
  await db('ei_snapshots').insert({
    captured_at: report.generatedAt,
    // knex needs the object serialised for a jsonb column on insert.
    report: JSON.stringify(report),
  });
}

/** Most recent snapshot, or undefined before the first refresh completes. */
export async function latestSnapshot(
  db: Knexish,
): Promise<Snapshot | undefined> {
  const rows = await db('ei_snapshots')
    .orderBy('captured_at', 'desc')
    .limit(1)
    .select('captured_at', 'report');
  const row = rows?.[0];
  if (!row) return undefined;
  return { capturedAt: toIso(row.captured_at), report: parseReport(row.report) };
}

export async function listSnapshots(
  db: Knexish,
  limit: number,
): Promise<Snapshot[]> {
  const rows = await db('ei_snapshots')
    .orderBy('captured_at', 'desc')
    .limit(limit)
    .select('captured_at', 'report');
  return (rows ?? []).map((row: any) => ({
    capturedAt: toIso(row.captured_at),
    report: parseReport(row.report),
  }));
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

// The pg driver returns a jsonb column already parsed, but knex hands the raw
// string through in some configurations. Accept both rather than assuming.
function parseReport(value: unknown): HealthReport {
  if (typeof value === 'string') return JSON.parse(value) as HealthReport;
  return value as HealthReport;
}
