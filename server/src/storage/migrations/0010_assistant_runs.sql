-- What each run of the assistant's heartbeat and scheduled tasks came to: nothing new,
-- something reported, or a failure. Silent heartbeat runs live only here — they never
-- reach the Activity list or the thread. docs/assistant/design.md §6.

CREATE TABLE IF NOT EXISTS assistant_runs (
  id           TEXT PRIMARY KEY,
  schedule_id  INTEGER NOT NULL,     -- cronjobs.id (task_type 'assistant')
  outcome      TEXT NOT NULL,        -- silent | found | failed
  note         TEXT,
  activity_id  TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assistant_runs_schedule ON assistant_runs(schedule_id, created_at);
