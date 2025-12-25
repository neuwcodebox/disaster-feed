CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY,
  source INTEGER NOT NULL,
  kind INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NULL,
  fetched_at TIMESTAMPTZ NOT NULL,
  occurred_at TIMESTAMPTZ NULL,
  region_text TEXT NULL,
  level INTEGER NOT NULL,
  link TEXT NULL,
  payload JSONB NULL
);

CREATE INDEX IF NOT EXISTS idx_events_fetched_at ON events (fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_kind_fetched_at ON events (kind, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_source_fetched_at ON events (source, fetched_at DESC);
