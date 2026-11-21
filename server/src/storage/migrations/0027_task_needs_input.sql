-- Tasks gain a `needs_input` status: the task's agent is blocked on a person
-- (an approval, a question, a plan to review, or a decision it asked for in a
-- comment). SQLite cannot alter a CHECK constraint, so the table is rebuilt.
--
-- Foreign keys are on (better-sqlite3 default) and cannot be switched off inside
-- the migration's transaction, so dropping `tasks` cascades into spec_artifacts
-- (task_id REFERENCES tasks ON DELETE CASCADE). Its rows are set aside and put
-- back once the new table carries the name again. The AUTOINCREMENT high-water
-- mark is kept too, so a deleted task's id is never handed out again.

CREATE TEMP TABLE _spec_artifacts_keep AS SELECT * FROM spec_artifacts;
CREATE TEMP TABLE _tasks_seq_keep AS SELECT seq FROM sqlite_sequence WHERE name = 'tasks';

CREATE TABLE tasks_new (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id        INTEGER NOT NULL,                -- logical ref: projects(id)
  number            INTEGER NOT NULL,                -- per-project sequential (#1, #2, ... → OP-42)
  title             TEXT    NOT NULL,
  description       TEXT    NOT NULL DEFAULT '',     -- markdown spec the agent works from
  status            TEXT    NOT NULL DEFAULT 'todo'
    CHECK(status IN ('todo', 'in_progress', 'needs_input', 'in_review', 'done', 'cancelled')),
  priority          INTEGER NOT NULL DEFAULT 0       -- 0 none, 1 low, 2 medium, 3 high, 4 urgent (DESC = urgent first)
    CHECK(priority BETWEEN 0 AND 4),
  assigned_agent_id INTEGER,                         -- logical ref: agents(id); NULL = unassigned
  parent_task_id    INTEGER,                         -- logical ref: tasks(id)
  source_channel_id INTEGER,                         -- logical ref: channels(id); where captured (NULL = standalone)
  source_message_id INTEGER,                         -- logical ref: channel_messages(id); NULL = not from a message
  branch_name       TEXT,                            -- git branch for this task
  workspace_id      INTEGER,                         -- logical ref: workspaces(id); per-task worktree
  binding_id        INTEGER,                         -- logical ref: agent_bindings(id); set when dispatched
  created_by        TEXT    NOT NULL DEFAULT 'human'
    CHECK(created_by IN ('human', 'agent')),
  created_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  archived_at       INTEGER,
  source_chat_id    INTEGER,
  blocked_by        TEXT,
  UNIQUE (project_id, number)
);

INSERT INTO tasks_new (
  id, project_id, number, title, description, status, priority, assigned_agent_id,
  parent_task_id, source_channel_id, source_message_id, branch_name, workspace_id,
  binding_id, created_by, created_at, updated_at, archived_at, source_chat_id, blocked_by
)
SELECT
  id, project_id, number, title, description, status, priority, assigned_agent_id,
  parent_task_id, source_channel_id, source_message_id, branch_name, workspace_id,
  binding_id, created_by, created_at, updated_at, archived_at, source_chat_id, blocked_by
FROM tasks;

DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;

UPDATE sqlite_sequence
SET seq = MAX(seq, COALESCE((SELECT seq FROM _tasks_seq_keep), 0))
WHERE name = 'tasks';

CREATE INDEX idx_tasks_project_status ON tasks(project_id, status);
CREATE INDEX idx_tasks_assignee ON tasks(assigned_agent_id) WHERE assigned_agent_id IS NOT NULL;
CREATE INDEX idx_tasks_parent ON tasks(parent_task_id) WHERE parent_task_id IS NOT NULL;
CREATE INDEX idx_tasks_project_archived ON tasks(project_id, archived_at);

INSERT INTO spec_artifacts SELECT * FROM _spec_artifacts_keep;

DROP TABLE _spec_artifacts_keep;
DROP TABLE _tasks_seq_keep;
