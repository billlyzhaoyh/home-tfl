-- Trips and settings for one household. Rows are JSON blobs; updated_at is the phone's
-- edit time (newest wins), synced_at is the server's clock (used as the pull cursor).
CREATE TABLE IF NOT EXISTS trips (
  id TEXT PRIMARY KEY,
  data TEXT,
  updated_at INTEGER NOT NULL,
  synced_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS trips_synced_at ON trips (synced_at);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  synced_at INTEGER NOT NULL
);
