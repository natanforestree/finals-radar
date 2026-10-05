-- Ruby Radar lobby log. Apply with `npm run db:init`.
-- Columns are snake_case; the API maps them to camelCase JSON.
CREATE TABLE IF NOT EXISTS lobbies (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  t             INTEGER NOT NULL,  -- server time, unix seconds
  who           TEXT    NOT NULL,  -- tapper's name, 1-24 chars, trimmed
  result        TEXT    NOT NULL,  -- 'sweaty' | 'normal'
  verdict       TEXT    NOT NULL,  -- 'queue' | 'coin' | 'wait' | 'calibrating' | 'stale' | 'unknown'
  view          TEXT    NOT NULL,  -- 'am' | 'global'
  share         REAL,              -- share the verdict used (0..1, or NULL)
  global_share  REAL,              -- latest global Ruby share
  am_share      REAL,              -- latest Americas Ruby share
  lb_updated_at TEXT               -- latest.json leaderboardUpdatedAt (ISO)
);

CREATE INDEX IF NOT EXISTS lobbies_t ON lobbies (t);
CREATE INDEX IF NOT EXISTS lobbies_who_t ON lobbies (who, t);
