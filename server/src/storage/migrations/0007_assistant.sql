-- Personal assistant (docs/assistant/design.md): one thread that never resets on
-- screen, plus the workers it dispatched. The model-side session rotates under
-- this; these tables are what the user sees.

CREATE TABLE IF NOT EXISTS assistant_messages (
  id          TEXT PRIMARY KEY,
  role        TEXT NOT NULL,        -- user | assistant
  text        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  trigger_json TEXT,                -- json AssistantTrigger
  activity_id TEXT,
  remembered  TEXT                  -- json string[]
);
CREATE INDEX IF NOT EXISTS idx_assistant_messages_created ON assistant_messages(created_at);

-- One row per worker. Steps are small and only ever read with their activity,
-- so they live inline as json rather than in a table of their own.
CREATE TABLE IF NOT EXISTS assistant_activities (
  id          TEXT PRIMARY KEY,     -- worker agent id (frame main/<id>)
  task_id     TEXT NOT NULL,        -- framework background task id
  title       TEXT NOT NULL,
  summary     TEXT NOT NULL,
  status      TEXT NOT NULL,        -- running | waiting | done | partial | failed | stopped
  source      TEXT,                 -- heartbeat | schedule (null = dispatched from chat)
  report      TEXT,
  steps       TEXT NOT NULL,        -- json ActivityStep[]
  started_at  INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_assistant_activities_started ON assistant_activities(started_at);
