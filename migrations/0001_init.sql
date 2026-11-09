-- Users are keyed by GitHub's numeric id, because logins can change hands.
CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  login       TEXT NOT NULL,
  name        TEXT,
  avatar_url  TEXT,
  is_public   INTEGER NOT NULL DEFAULT 0,
  timezone    TEXT NOT NULL DEFAULT 'UTC',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX users_login ON users (login COLLATE NOCASE);

-- Only hashes of session tokens are stored.
CREATE TABLE sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('web', 'agent')),
  machine_id   TEXT,
  created_at   TEXT NOT NULL,
  expires_at   TEXT
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE machines (
  user_id        TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  id             TEXT NOT NULL,
  name           TEXT NOT NULL,
  platform       TEXT,
  agent_version  TEXT,
  created_at     TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);

-- One row per machine, day and model. An upload replaces a machine's rows for that day.
CREATE TABLE usage_daily (
  user_id      TEXT NOT NULL,
  machine_id   TEXT NOT NULL,
  day          TEXT NOT NULL,
  tool         TEXT NOT NULL,
  model        TEXT NOT NULL,
  input        INTEGER NOT NULL,
  output       INTEGER NOT NULL,
  cache_read   INTEGER NOT NULL,
  cache_write  INTEGER NOT NULL,
  messages     INTEGER NOT NULL,
  PRIMARY KEY (user_id, machine_id, day, tool, model),
  FOREIGN KEY (user_id, machine_id) REFERENCES machines (user_id, id) ON DELETE CASCADE
) WITHOUT ROWID;

-- Each tool's own lifetime figure, as last reported by a machine.
CREATE TABLE tool_totals (
  user_id     TEXT NOT NULL,
  machine_id  TEXT NOT NULL,
  tool        TEXT NOT NULL,
  payload     TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, machine_id, tool),
  FOREIGN KEY (user_id, machine_id) REFERENCES machines (user_id, id) ON DELETE CASCADE
) WITHOUT ROWID;

-- Aggregated GitHub metrics, computed on a machine. Holds no repository names.
CREATE TABLE github_stats (
  user_id       TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  payload       TEXT NOT NULL,
  collected_at  TEXT NOT NULL
);

CREATE TABLE kv (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
