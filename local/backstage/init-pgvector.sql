-- Runs automatically on first Postgres container start (docker-entrypoint-initdb.d).
-- For existing volumes run manually:
--   docker compose -f local/backstage/docker-compose.yml exec postgres \
--     psql -U backstage -f /docker-entrypoint-initdb.d/init-pgvector.sql

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS rag_documents (
  id          TEXT        PRIMARY KEY,
  title       TEXT        NOT NULL,
  kind        TEXT,
  url         TEXT,
  content     TEXT,
  embedding   vector(512),
  indexed_at  TIMESTAMPTZ DEFAULT NOW()
);

-- HNSW index: no training required, works with any row count, good for dynamic upserts
CREATE INDEX IF NOT EXISTS rag_documents_embedding_idx
  ON rag_documents USING hnsw (embedding vector_cosine_ops);
