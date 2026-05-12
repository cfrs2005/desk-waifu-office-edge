-- D1 schema. D1 is SQLite-compatible but with caveats: no pragmas,
-- no AUTOINCREMENT-without-INTEGER-PK, no WAL mode (managed for us).
-- Everything below is portable plain SQLite that runs unchanged locally.

CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY,
  api_key_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  user TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (user, agent_name, instance_id)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  type TEXT NOT NULL,
  value TEXT NOT NULL,
  ts INTEGER NOT NULL
);
-- timeline ordering is purely by id DESC, but seat-latest lookup hits
-- (user,agent,instance,type,ts) — index covers both.
CREATE INDEX IF NOT EXISTS idx_events_seat ON events(user, agent_name, instance_id, type, ts);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);

CREATE TABLE IF NOT EXISTS assets (
  user TEXT NOT NULL,
  state TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  PRIMARY KEY (user, state)
);

CREATE TABLE IF NOT EXISTS idempotency (
  client_id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL
);
