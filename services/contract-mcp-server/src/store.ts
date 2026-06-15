import { parseSpec, extractPaths } from './generator.js';

export interface ContractEntry {
  version: string;
  specJson: string;
  timestamp: string;
  paths: string[];
}

export interface StoreSummary {
  serviceName: string;
  versions: string[];
  latestVersion: string;
  registeredAt: string;
}

export interface ContractStore {
  register(serviceName: string, version: string, specString: string): Promise<ContractEntry>;
  getLatest(serviceName: string): Promise<ContractEntry | undefined>;
  getByVersion(serviceName: string, version: string): Promise<ContractEntry | undefined>;
  listAll(): Promise<StoreSummary[]>;
}

// ── In-memory store (default, dev/testing) ────────────────────────────────

class InMemoryStore implements ContractStore {
  private readonly contracts = new Map<string, ContractEntry[]>();

  async register(serviceName: string, version: string, specString: string): Promise<ContractEntry> {
    const parsed = parseSpec(specString);
    const paths = extractPaths(parsed);
    const entry: ContractEntry = { version, specJson: JSON.stringify(parsed), timestamp: new Date().toISOString(), paths };
    const entries = this.contracts.get(serviceName) ?? [];
    const idx = entries.findIndex(e => e.version === version);
    if (idx >= 0) { entries[idx] = entry; } else { entries.push(entry); }
    this.contracts.set(serviceName, entries);
    return entry;
  }

  async getLatest(serviceName: string): Promise<ContractEntry | undefined> {
    const entries = this.contracts.get(serviceName);
    return entries?.[entries.length - 1];
  }

  async getByVersion(serviceName: string, version: string): Promise<ContractEntry | undefined> {
    return this.contracts.get(serviceName)?.find(e => e.version === version);
  }

  async listAll(): Promise<StoreSummary[]> {
    return Array.from(this.contracts.entries()).map(([serviceName, entries]) => {
      const latest = entries[entries.length - 1];
      return {
        serviceName,
        versions: entries.map(e => e.version),
        latestVersion: latest?.version ?? 'none',
        registeredAt: latest?.timestamp ?? '',
      };
    });
  }
}

// ── PostgreSQL store ───────────────────────────────────────────────────────

class PostgresStore implements ContractStore {
  // Dynamic import — avoids hard dep when STORAGE_TYPE != postgres
  private pool!: import('pg').Pool;

  static async create(connectionString: string): Promise<PostgresStore> {
    const { default: pg } = await import('pg');
    const store = new PostgresStore();
    store.pool = new pg.Pool({ connectionString, max: 5 });
    await store.pool.query(`
      CREATE TABLE IF NOT EXISTS contracts (
        service_name TEXT NOT NULL,
        version      TEXT NOT NULL,
        spec_json    TEXT NOT NULL,
        paths        TEXT[] NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (service_name, version)
      )
    `);
    return store;
  }

  async register(serviceName: string, version: string, specString: string): Promise<ContractEntry> {
    const parsed = parseSpec(specString);
    const paths = extractPaths(parsed);
    const specJson = JSON.stringify(parsed);
    const timestamp = new Date().toISOString();
    await this.pool.query(
      `INSERT INTO contracts (service_name, version, spec_json, paths, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (service_name, version)
       DO UPDATE SET spec_json = EXCLUDED.spec_json, paths = EXCLUDED.paths, created_at = EXCLUDED.created_at`,
      [serviceName, version, specJson, paths, timestamp],
    );
    return { version, specJson, timestamp, paths };
  }

  async getLatest(serviceName: string): Promise<ContractEntry | undefined> {
    const res = await this.pool.query<{ version: string; spec_json: string; paths: string[]; created_at: Date }>(
      `SELECT version, spec_json, paths, created_at FROM contracts
       WHERE service_name = $1 ORDER BY created_at DESC LIMIT 1`,
      [serviceName],
    );
    const row = res.rows[0];
    if (!row) return undefined;
    return { version: row.version, specJson: row.spec_json, paths: row.paths, timestamp: row.created_at.toISOString() };
  }

  async getByVersion(serviceName: string, version: string): Promise<ContractEntry | undefined> {
    const res = await this.pool.query<{ version: string; spec_json: string; paths: string[]; created_at: Date }>(
      `SELECT version, spec_json, paths, created_at FROM contracts
       WHERE service_name = $1 AND version = $2`,
      [serviceName, version],
    );
    const row = res.rows[0];
    if (!row) return undefined;
    return { version: row.version, specJson: row.spec_json, paths: row.paths, timestamp: row.created_at.toISOString() };
  }

  async listAll(): Promise<StoreSummary[]> {
    const res = await this.pool.query<{ service_name: string; versions: string[]; latest_version: string; registered_at: Date }>(`
      SELECT
        service_name,
        array_agg(version ORDER BY created_at) AS versions,
        (array_agg(version ORDER BY created_at DESC))[1] AS latest_version,
        max(created_at) AS registered_at
      FROM contracts
      GROUP BY service_name
      ORDER BY service_name
    `);
    return res.rows.map(r => ({
      serviceName: r.service_name,
      versions: r.versions,
      latestVersion: r.latest_version,
      registeredAt: r.registered_at.toISOString(),
    }));
  }
}

// ── DynamoDB store ─────────────────────────────────────────────────────────

class DynamoStore implements ContractStore {
  private docClient!: import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(tableName: string) {
    this.tableName = tableName;
  }

  static async create(region: string, tableName: string): Promise<DynamoStore> {
    const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
    const { DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb');
    const store = new DynamoStore(tableName);
    store.docClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
    return store;
  }

  async register(serviceName: string, version: string, specString: string): Promise<ContractEntry> {
    const { PutCommand } = await import('@aws-sdk/lib-dynamodb');
    const parsed = parseSpec(specString);
    const paths = extractPaths(parsed);
    const specJson = JSON.stringify(parsed);
    const timestamp = new Date().toISOString();
    await this.docClient.send(new PutCommand({
      TableName: this.tableName,
      Item: { service_name: serviceName, version, spec_json: specJson, paths, created_at: timestamp },
    }));
    return { version, specJson, timestamp, paths };
  }

  async getLatest(serviceName: string): Promise<ContractEntry | undefined> {
    const { QueryCommand } = await import('@aws-sdk/lib-dynamodb');
    const res = await this.docClient.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'service_name = :sn',
      ExpressionAttributeValues: { ':sn': serviceName },
      ScanIndexForward: false,
      Limit: 1,
    }));
    const item = res.Items?.[0] as { version: string; spec_json: string; paths: string[]; created_at: string } | undefined;
    if (!item) return undefined;
    return { version: item.version, specJson: item.spec_json, paths: item.paths, timestamp: item.created_at };
  }

  async getByVersion(serviceName: string, version: string): Promise<ContractEntry | undefined> {
    const { GetCommand } = await import('@aws-sdk/lib-dynamodb');
    const res = await this.docClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { service_name: serviceName, version },
    }));
    const item = res.Item as { version: string; spec_json: string; paths: string[]; created_at: string } | undefined;
    if (!item) return undefined;
    return { version: item.version, specJson: item.spec_json, paths: item.paths, timestamp: item.created_at };
  }

  async listAll(): Promise<StoreSummary[]> {
    const { ScanCommand } = await import('@aws-sdk/lib-dynamodb');
    const res = await this.docClient.send(new ScanCommand({ TableName: this.tableName }));
    const byService = new Map<string, Array<{ version: string; created_at: string }>>();
    for (const item of (res.Items ?? []) as Array<{ service_name: string; version: string; created_at: string }>) {
      const list = byService.get(item.service_name) ?? [];
      list.push({ version: item.version, created_at: item.created_at });
      byService.set(item.service_name, list);
    }
    return Array.from(byService.entries()).map(([serviceName, items]) => {
      const sorted = items.sort((a, b) => a.created_at.localeCompare(b.created_at));
      return {
        serviceName,
        versions: sorted.map(i => i.version),
        latestVersion: sorted[sorted.length - 1]?.version ?? 'none',
        registeredAt: sorted[sorted.length - 1]?.created_at ?? '',
      };
    });
  }
}

// ── Factory ────────────────────────────────────────────────────────────────

export async function createStore(): Promise<ContractStore> {
  const type = (process.env.STORAGE_TYPE ?? 'memory').toLowerCase();

  if (type === 'postgres') {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is required when STORAGE_TYPE=postgres');
    console.log('Using PostgreSQL contract store');
    return PostgresStore.create(url);
  }

  if (type === 'dynamodb') {
    const region = process.env.AWS_REGION ?? 'us-east-1';
    const table = process.env.DYNAMO_TABLE ?? 'contract-registry';
    console.log(`Using DynamoDB contract store (table: ${table})`);
    return DynamoStore.create(region, table);
  }

  console.log('Using in-memory contract store (non-persistent)');
  return new InMemoryStore();
}
