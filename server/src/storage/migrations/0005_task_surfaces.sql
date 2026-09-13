-- Linear issues / agent sessions and GitHub pull requests hang off a task as
-- "surfaces" (docs/linear-github/design.md §7). The task stays the truth; a
-- surface is where the same work is visible and steerable from outside.

CREATE TABLE IF NOT EXISTS task_surfaces (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     INTEGER NOT NULL,
  kind        TEXT NOT NULL,        -- linear_issue | linear_session | github_pr
  external_id TEXT NOT NULL,        -- issue id | agent session id | owner/name#number
  url         TEXT,
  meta        TEXT,                 -- json: identifier, org_id, team_id, repo, head, base, state…
  created_at  INTEGER NOT NULL,
  UNIQUE (kind, external_id)
);
CREATE INDEX IF NOT EXISTS idx_task_surfaces_task ON task_surfaces(task_id);

-- A question or approval the agent is waiting on, posted to a surface; the
-- next reply there from the task's owner answers it.
CREATE TABLE IF NOT EXISTS surface_pending (
  approval_id  TEXT PRIMARY KEY,
  task_id      INTEGER NOT NULL,
  chat_id      INTEGER NOT NULL,
  surface_kind TEXT NOT NULL,       -- linear_session | github_pr
  surface_ref  TEXT NOT NULL,       -- session id | owner/name#number
  tool_name    TEXT NOT NULL,
  input        TEXT NOT NULL,       -- json
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_surface_pending_task ON surface_pending(task_id);

-- Second idempotency layer: the broker's queue can replay a delivery.
CREATE TABLE IF NOT EXISTS surface_deliveries (
  delivery_id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
);
