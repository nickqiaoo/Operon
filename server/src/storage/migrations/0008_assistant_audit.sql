-- Every permission decision a worker of the personal assistant ran into: the
-- user's answers on approval cards, plus the ones made automatically (a site the
-- user named in their request). docs/assistant/design.md §7.

CREATE TABLE IF NOT EXISTS assistant_audit (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  detail      TEXT NOT NULL,
  icon        TEXT NOT NULL,        -- globe | app | file | terminal | tool
  decision    TEXT NOT NULL,        -- allowed_once | always_allowed | auto_allowed | denied
  args        TEXT,                 -- json
  activity_id TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assistant_audit_created ON assistant_audit(created_at);
