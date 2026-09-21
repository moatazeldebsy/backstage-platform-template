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
  // Verified Backstage userEntityRef of the human the requesting agent is
  // acting for — set once callers pass a server-verified X-Backstage-User
  // through to request_approval. Nullable: rows created before this column
  // existed, and any caller not yet on the identity-verified path, have none.
  requested_by_user: string | null;
}

export interface ConsentGrant {
  id: string;
  user_ref: string;
  agent: string;
  scope: string;
  granted_at: string;
  expires_at: string | null;
  revoked_at: string | null;
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

const AGENT_APPROVALS_DDL = `
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
`;

const CONSENT_GRANTS_DDL = `
  CREATE TABLE IF NOT EXISTS consent_grants (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_ref    TEXT NOT NULL,
    agent       TEXT NOT NULL,
    scope       TEXT NOT NULL,
    granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ,
    revoked_at  TIMESTAMPTZ,
    UNIQUE (user_ref, agent, scope)
  )
`;

export async function initSchema(): Promise<void> {
  await getPool().query(AGENT_APPROVALS_DDL).catch(async (err: Error) => {
    // gen_random_uuid() needs pgcrypto on older Postgres; pgvector/pgvector:pg17 ships it enabled,
    // but fall back to creating the extension explicitly if the table creation failed because of it.
    if (/gen_random_uuid/.test(err.message)) {
      await getPool().query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
      await getPool().query(AGENT_APPROVALS_DDL);
      return;
    }
    throw err;
  });
  // requested_by_user post-dates the original table — ADD COLUMN IF NOT EXISTS
  // so existing deployments pick it up without a separate migration step.
  await getPool().query(`ALTER TABLE agent_approvals ADD COLUMN IF NOT EXISTS requested_by_user TEXT`);
  await getPool().query(CONSENT_GRANTS_DDL);
}

export async function createApproval(action: string, agent: string, target: string, context: Record<string, unknown>, requestedByUser?: string): Promise<Approval> {
  const { rows } = await getPool().query(
    `INSERT INTO agent_approvals (action, agent, target, context, requested_by_user) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [action, agent, target, JSON.stringify(context), requestedByUser ?? null],
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

// A user standing-authorizes a specific agent to use a specific tool/scope on
// their behalf. This answers "did the user this agent claims to act for
// actually agree to that" — a different question from agent_approvals, which
// answers "did *some* authorized human sign off on this specific call".
// UPSERT: re-granting an existing (user_ref, agent, scope) un-revokes it and
// refreshes granted_at/expires_at, rather than erroring on the unique constraint.
export async function grantConsent(userRef: string, agent: string, scope: string, expiresAt?: string | null): Promise<ConsentGrant> {
  const { rows } = await getPool().query(
    `INSERT INTO consent_grants (user_ref, agent, scope, expires_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_ref, agent, scope)
     DO UPDATE SET granted_at = NOW(), expires_at = EXCLUDED.expires_at, revoked_at = NULL
     RETURNING *`,
    [userRef, agent, scope, expiresAt ?? null],
  );
  return rows[0];
}

export async function revokeConsent(userRef: string, agent: string, scope: string): Promise<ConsentGrant | null> {
  const { rows } = await getPool().query(
    `UPDATE consent_grants SET revoked_at = NOW()
     WHERE user_ref = $1 AND agent = $2 AND scope = $3 AND revoked_at IS NULL
     RETURNING *`,
    [userRef, agent, scope],
  );
  return rows[0] ?? null;
}

// Active = exists, not revoked, and (no expiry or expiry in the future).
export async function checkConsent(userRef: string, agent: string, scope: string): Promise<ConsentGrant | null> {
  const { rows } = await getPool().query(
    `SELECT * FROM consent_grants
     WHERE user_ref = $1 AND agent = $2 AND scope = $3
       AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > NOW())`,
    [userRef, agent, scope],
  );
  return rows[0] ?? null;
}

export async function listConsentGrants(userRef: string): Promise<ConsentGrant[]> {
  const { rows } = await getPool().query(
    `SELECT * FROM consent_grants WHERE user_ref = $1 ORDER BY granted_at DESC`,
    [userRef],
  );
  return rows;
}
