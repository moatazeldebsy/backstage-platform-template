import { createBackendPlugin, coreServices } from '@backstage/backend-plugin-api';
import express, { Router } from 'express';

const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings';
const VOYAGE_MODEL = 'voyage-3-lite';
const EMBED_DIM = 512;
const BATCH_SIZE = 50;
const SEARCH_LIMIT = 10;

async function embedTexts(
  texts: string[],
  apiKey: string,
): Promise<number[][]> {
  const resp = await fetch(VOYAGE_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ input: texts, model: VOYAGE_MODEL }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Voyage AI error ${resp.status}: ${body}`);
  }
  const json = (await resp.json()) as { data: { embedding: number[] }[] };
  return json.data.map(d => d.embedding);
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function truncate(text: string, maxChars = 2000): string {
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function vectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}

export const ragSearchPlugin = createBackendPlugin({
  pluginId: 'rag-search',
  register(env) {
    env.registerInit({
      deps: {
        httpRouter: coreServices.httpRouter,
        config: coreServices.rootConfig,
        database: coreServices.database,
        logger: coreServices.logger,
        scheduler: coreServices.scheduler,
        discovery: coreServices.discovery,
        auth: coreServices.auth,
      },
      async init({ httpRouter, config, database, logger, scheduler, discovery, auth }) {
        const apiKey = config.getOptionalString('ragSearch.voyageApiKey') ?? '';
        const intervalMinutes = config.getOptionalNumber('ragSearch.indexIntervalMinutes') ?? 30;
        const externalSources: { url: string; title: string }[] =
          (config.getOptional('ragSearch.externalSources') as any[]) ?? [];

        const db = await database.getClient();

        // Ensure pgvector extension and table exist (idempotent — safe on existing DBs)
        await db.raw('CREATE EXTENSION IF NOT EXISTS vector');
        await db.raw(`
          CREATE TABLE IF NOT EXISTS rag_documents (
            id          TEXT        PRIMARY KEY,
            title       TEXT        NOT NULL,
            kind        TEXT,
            url         TEXT,
            content     TEXT,
            embedding   vector(${EMBED_DIM}),
            indexed_at  TIMESTAMPTZ DEFAULT NOW()
          )
        `);
        await db.raw(`
          CREATE INDEX IF NOT EXISTS rag_documents_embedding_idx
            ON rag_documents USING hnsw (embedding vector_cosine_ops)
        `);

        // ── Indexer ────────────────────────────────────────────────────────────

        async function upsertDocs(
          docs: { id: string; title: string; kind: string; url: string; content: string }[],
        ) {
          if (!apiKey) {
            logger.warn('ragSearch.voyageApiKey not set — skipping embedding');
            return;
          }
          for (let i = 0; i < docs.length; i += BATCH_SIZE) {
            const batch = docs.slice(i, i + BATCH_SIZE);
            const texts = batch.map(d => truncate(`${d.title}\n${d.content}`));
            let embeddings: number[][];
            try {
              embeddings = await embedTexts(texts, apiKey);
            } catch (err: any) {
              logger.error(`Voyage AI embed failed: ${err.message}`);
              continue;
            }
            for (let j = 0; j < batch.length; j++) {
              const doc = batch[j];
              const vec = vectorLiteral(embeddings[j]);
              await db.raw(
                `INSERT INTO rag_documents (id, title, kind, url, content, embedding, indexed_at)
                 VALUES (?, ?, ?, ?, ?, ?::vector, NOW())
                 ON CONFLICT (id) DO UPDATE SET
                   title = EXCLUDED.title,
                   kind = EXCLUDED.kind,
                   url = EXCLUDED.url,
                   content = EXCLUDED.content,
                   embedding = EXCLUDED.embedding,
                   indexed_at = NOW()`,
                [doc.id, doc.title, doc.kind, doc.url, doc.content, vec],
              );
            }
            logger.info(`RAG: indexed batch ${i / BATCH_SIZE + 1} (${batch.length} docs)`);
          }
        }

        async function indexCatalog() {
          const catalogBase = await discovery.getBaseUrl('catalog');
          const { token } = await auth.getPluginRequestToken({
            onBehalfOf: await auth.getOwnServiceCredentials(),
            targetPluginId: 'catalog',
          });
          const resp = await fetch(`${catalogBase}/entities?limit=500`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!resp.ok) {
            logger.warn(`Catalog fetch failed: ${resp.status}`);
            return;
          }
          const entities: any[] = await resp.json();
          const docs = entities.map((e: any) => {
            const ref = `${e.kind}:${e.metadata?.namespace ?? 'default'}/${e.metadata?.name}`;
            const desc = e.metadata?.description ?? '';
            const tags: string = (e.metadata?.tags ?? []).join(' ');
            const owner: string = e.spec?.owner ?? '';
            const content = [desc, tags, owner].filter(Boolean).join('\n');
            const appBaseUrl = config.getString('app.baseUrl');
            const searchUrl = `${appBaseUrl}/catalog/${e.metadata?.namespace ?? 'default'}/${e.kind.toLowerCase()}/${e.metadata?.name}`;
            return { id: `catalog:${ref}`, title: e.metadata?.name ?? ref, kind: e.kind, url: searchUrl, content };
          });
          await upsertDocs(docs);
          logger.info(`RAG: catalog index complete (${docs.length} entities)`);
        }

        async function indexExternalSources() {
          const docs: { id: string; title: string; kind: string; url: string; content: string }[] = [];
          for (const src of externalSources) {
            try {
              const resp = await fetch(src.url);
              if (!resp.ok) continue;
              const text = stripHtml(await resp.text());
              docs.push({ id: `ext:${src.url}`, title: src.title, kind: 'ExternalDoc', url: src.url, content: truncate(text) });
            } catch (err: any) {
              logger.warn(`RAG: failed to fetch ${src.url}: ${err.message}`);
            }
          }
          if (docs.length) await upsertDocs(docs);
        }

        async function runIndex() {
          logger.info('RAG: starting index run');
          await indexCatalog();
          await indexExternalSources();
          logger.info('RAG: index run complete');
        }

        // Schedule periodic re-index; initial delay lets catalog finish initializing first
        await scheduler.scheduleTask({
          id: 'rag-search-indexer',
          frequency: { minutes: intervalMinutes },
          initialDelay: { seconds: 30 },
          timeout: { minutes: 10 },
          fn: async () => { await runIndex(); },
        });

        // ── HTTP Router ────────────────────────────────────────────────────────

        const router = Router();
        router.use(express.json());

        // GET /api/rag-search/search?q=<query>
        router.get('/search', async (req, res) => {
          const query = String(req.query.q ?? '').trim();
          if (!query) {
            res.status(400).json({ error: 'q parameter is required' });
            return;
          }
          if (!apiKey) {
            res.status(503).json({ error: 'VOYAGE_API_KEY not configured' });
            return;
          }
          let queryEmbedding: number[];
          try {
            [queryEmbedding] = await embedTexts([query], apiKey);
          } catch (err: any) {
            res.status(502).json({ error: `Embedding failed: ${err.message}` });
            return;
          }
          const vec = vectorLiteral(queryEmbedding);
          const { rows } = await db.raw(
            `SELECT id, title, kind, url, content,
                    1 - (embedding <=> ?::vector) AS similarity
             FROM rag_documents
             WHERE embedding IS NOT NULL
             ORDER BY embedding <=> ?::vector
             LIMIT ?`,
            [vec, vec, SEARCH_LIMIT],
          );
          res.json({ results: rows });
        });

        // POST /api/rag-search/index — trigger manual re-index
        router.post('/index', async (_req, res) => {
          runIndex().catch(err => logger.warn(`Manual index failed: ${err.message}`));
          res.json({ message: 'Indexing started' });
        });

        // GET /api/rag-search/status
        router.get('/status', async (_req, res) => {
          const { rows } = await db.raw(
            `SELECT COUNT(*) AS count, MAX(indexed_at) AS last_indexed FROM rag_documents`,
          );
          res.json({ documentCount: Number(rows[0].count), lastIndexed: rows[0].last_indexed });
        });

        httpRouter.use(router);
        httpRouter.addAuthPolicy({ path: '/search', allow: 'unauthenticated' });
        httpRouter.addAuthPolicy({ path: '/index', allow: 'unauthenticated' });
        httpRouter.addAuthPolicy({ path: '/status', allow: 'unauthenticated' });
      },
    });
  },
});
