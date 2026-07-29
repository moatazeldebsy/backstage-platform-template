import pg from 'pg';

const { Pool } = pg;

export interface Approval {
  id: string;
  action: string;
  agent: string;
  target: string;
  context: Record<string, unknown>;
  status: 'pending' | 'approved' | 'denied';
  requested_at: string;
  decided_at: string | null;
  decided_by: string | null;
}

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({
      host: process.env.POSTGRES_HOST ?? 'localhost',
      port: parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
      user: process.env.POSTGRES_USER ?? 'backstage',
      password: process.env.POSTGRES_PASSWORD ?? 'backstage',
      database: process.env.POSTGRES_DB ?? 'backstage',
      ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
      max: 5,
    });
  }
  return pool;
}

export async function initSchema(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS agent_approvals (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      action       TEXT NOT NULL,
      agent        TEXT NOT NULL,
      target       TEXT NOT NULL,
      context      JSONB NOT NULL DEFAULT '{}',
      status       TEXT NOT NULL DEFAULT 'pending',
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      decided_at   TIMESTAMPTZ,
      decided_by   TEXT
    )
  `).catch(async (err: Error) => {
    // gen_random_uuid() needs pgcrypto on older Postgres; pgvector/pgvector:pg17 ships it enabled,
    // but fall back to creating the extension explicitly if the table creation failed because of it.
    if (/gen_random_uuid/.test(err.message)) {
      await getPool().query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
      await getPool().query(`
        CREATE TABLE IF NOT EXISTS agent_approvals (
          id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          action       TEXT NOT NULL,
          agent        TEXT NOT NULL,
          target       TEXT NOT NULL,
          context      JSONB NOT NULL DEFAULT '{}',
          status       TEXT NOT NULL DEFAULT 'pending',
          requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          decided_at   TIMESTAMPTZ,
          decided_by   TEXT
        )
      `);
      return;
    }
    throw err;
  });
}

export async function createApproval(action: string, agent: string, target: string, context: Record<string, unknown>): Promise<Approval> {
  const { rows } = await getPool().query(
    `INSERT INTO agent_approvals (action, agent, target, context) VALUES ($1, $2, $3, $4) RETURNING *`,
    [action, agent, target, JSON.stringify(context)],
  );
  return rows[0];
}

export async function getApproval(id: string): Promise<Approval | null> {
  const { rows } = await getPool().query(`SELECT * FROM agent_approvals WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function listApprovals(status?: string): Promise<Approval[]> {
  if (status) {
    const { rows } = await getPool().query(`SELECT * FROM agent_approvals WHERE status = $1 ORDER BY requested_at DESC`, [status]);
    return rows;
  }
  const { rows } = await getPool().query(`SELECT * FROM agent_approvals ORDER BY requested_at DESC LIMIT 100`);
  return rows;
}

export async function decideApproval(id: string, decision: 'approved' | 'denied', decidedBy: string): Promise<Approval | null> {
  const { rows } = await getPool().query(
    `UPDATE agent_approvals SET status = $1, decided_at = NOW(), decided_by = $2 WHERE id = $3 AND status = 'pending' RETURNING *`,
    [decision, decidedBy, id],
  );
  return rows[0] ?? null;
}
