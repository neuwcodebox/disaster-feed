CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY,
  source SMALLINT NOT NULL,
  kind SMALLINT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NULL,
  fetched_at TIMESTAMPTZ NOT NULL,
  occurred_at TIMESTAMPTZ NULL,
  region_text TEXT NULL,
  level SMALLINT NOT NULL,
  payload JSONB NULL
);

CREATE INDEX IF NOT EXISTS idx_events_fetched_at ON events (fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_kind_fetched_at ON events (kind, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_source_fetched_at ON events (source, fetched_at DESC);

CREATE TABLE IF NOT EXISTS ingest_checkpoints (
  source_id INTEGER PRIMARY KEY,
  state TEXT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
