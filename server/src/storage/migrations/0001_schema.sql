-- ============================================================
-- operon schema — consolidated baseline.
--
-- This file is the squash of the pre-open-source migration history
-- (0001..0043, 2026-08), minus tables/columns that had become dead code.
-- It creates the complete current schema for a fresh database. Every
-- statement is IF NOT EXISTS, so running it on an already-up-to-date
-- database is a no-op (older databases keep their extra legacy
-- tables/columns; all of them have defaults, so that is harmless).
--
-- Future schema changes go in NEW files (0002_..., 0003_...): applied
-- migrations are checksummed and must never be edited.
-- ============================================================

CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  root_path  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL,
  name          TEXT NOT NULL,
  branch_name   TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workspaces_project_id
ON workspaces(project_id);

CREATE TABLE IF NOT EXISTS chats (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  tp                 TEXT NOT NULL DEFAULT 'chat',
  title              TEXT NOT NULL DEFAULT 'Chat',
  workspace_id       INTEGER,
  model              TEXT,
  provider_id        TEXT,
  session_id         TEXT,
  updated_at         INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  metadata           TEXT,
  revision           INTEGER NOT NULL DEFAULT 0
, thinking_level TEXT, last_extracted_message_index INTEGER);

CREATE INDEX IF NOT EXISTS idx_chats_workspace_updated_at
ON chats(workspace_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_chats_updated_at
ON chats(updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id       INTEGER NOT NULL,
  uid           TEXT NOT NULL,
  message_index INTEGER NOT NULL,
  payload       TEXT NOT NULL,
  UNIQUE (chat_id, message_index)
);

CREATE TABLE IF NOT EXISTS cronjobs (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  name                    TEXT NOT NULL,
  enabled                 INTEGER NOT NULL,
  task_type               TEXT NOT NULL DEFAULT 'chat',
  canvas_workflow_id      INTEGER,
  workspace_id            INTEGER,
  provider_id             TEXT NOT NULL,
  model_id                TEXT,
  mode_id                 TEXT,
  thinking_level          TEXT,
  prompt                  TEXT NOT NULL,
  schedule_type           TEXT NOT NULL,
  schedule_time           TEXT,
  schedule_days           TEXT,
  schedule_minutes        INTEGER,
  schedule_end_time       TEXT,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  last_run_at             INTEGER,
  next_run_at             INTEGER,
  last_result_status      TEXT CHECK (last_result_status IN ('success', 'error')),
  last_result_output      TEXT,
  last_result_error       TEXT,
  last_result_finished_at INTEGER,
  last_result_duration_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_cronjobs_due
ON cronjobs(enabled, next_run_at);

CREATE INDEX IF NOT EXISTS idx_cronjobs_updated_at
ON cronjobs(updated_at DESC);

CREATE TABLE IF NOT EXISTS cronjob_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     INTEGER UNIQUE,
  cronjob_id  INTEGER NOT NULL,
  timestamp   INTEGER NOT NULL,
  title       TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('success', 'error', 'unknown')),
  provider_id TEXT,
  model       TEXT
);

CREATE INDEX IF NOT EXISTS idx_cronjob_runs_job_time
ON cronjob_runs(cronjob_id, timestamp DESC);

CREATE TABLE IF NOT EXISTS checkpoints (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     INTEGER NOT NULL,
  message_uid TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  created_at  INTEGER NOT NULL, end_snapshot_id TEXT, overlapped INTEGER,
  UNIQUE (chat_id, message_uid)
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_chat_uid
ON checkpoints(chat_id, message_uid);

CREATE INDEX IF NOT EXISTS idx_checkpoints_chat_created
ON checkpoints(chat_id, created_at DESC);

CREATE TABLE IF NOT EXISTS canvas_workflows (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  description  TEXT,
  workspace_id INTEGER,
  nodes        TEXT NOT NULL,
  edges        TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_canvas_created
ON canvas_workflows(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_canvas_workspace_id
ON canvas_workflows(workspace_id);

CREATE TABLE IF NOT EXISTS canvas_workflow_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id INTEGER NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('running', 'success', 'error')),
  error       TEXT,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  outputs     TEXT
);

CREATE INDEX IF NOT EXISTS idx_canvas_workflow_runs
ON canvas_workflow_runs(workflow_id, started_at DESC);

CREATE TABLE IF NOT EXISTS canvas_node_results (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      INTEGER NOT NULL,
  node_id     TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('pending', 'running', 'success', 'error')),
  output      TEXT,
  error       TEXT,
  started_at  INTEGER,
  finished_at INTEGER,
  UNIQUE (run_id, node_id)
);

CREATE INDEX IF NOT EXISTS idx_canvas_run_nodes
ON canvas_node_results(run_id, node_id);

CREATE TABLE IF NOT EXISTS agents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL UNIQUE,         -- @mention handle, e.g. 'claude'
  provider    TEXT    NOT NULL,                -- 'claude-code' | 'codex' | 'gemini-cli'
  model       TEXT    NOT NULL,                -- 'sonnet' | 'opus' | 'gpt-5.4'
  instructions TEXT    NOT NULL DEFAULT '',     -- role description, injected into system prompt
  created_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
, permission_mode TEXT NOT NULL DEFAULT 'FullAccess', can_delegate INTEGER NOT NULL DEFAULT 0, env TEXT NOT NULL DEFAULT '[]', hidden INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS channels (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL,                -- logical ref: projects(id)
  name        TEXT    NOT NULL,
  description TEXT    NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_channels_project
ON channels(project_id);

CREATE TABLE IF NOT EXISTS channel_members (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL,                 -- logical ref: channels(id)
  agent_id   INTEGER NOT NULL,                 -- logical ref: agents(id)
  joined_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  UNIQUE (channel_id, agent_id)
);

CREATE TABLE IF NOT EXISTS channel_messages (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,  -- global monotonic seq, used as read cursor
  channel_id     INTEGER NOT NULL,                   -- logical ref: channels(id)
  thread_root_id INTEGER,                            -- NULL = root message; non-NULL = thread reply, logical ref: channel_messages(id)
  sender_type    TEXT    NOT NULL CHECK(sender_type IN ('human', 'agent', 'system')),
  sender_id      INTEGER,                            -- agents(id) when sender_type='agent', else NULL
  sender_name    TEXT    NOT NULL,                   -- display name
  content        TEXT    NOT NULL,
  reply_count    INTEGER NOT NULL DEFAULT 0,         -- cached thread reply count (root messages only)
  last_reply_at  INTEGER,                            -- cached last reply timestamp
  created_at     INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_messages_channel
ON channel_messages(channel_id, id);

CREATE INDEX IF NOT EXISTS idx_messages_thread
ON channel_messages(thread_root_id) WHERE thread_root_id IS NOT NULL;

CREATE VIRTUAL TABLE IF NOT EXISTS memory_timeline_fts USING fts5(
  entry,
  content='memory_timeline',
  content_rowid='id',
  tokenize='trigram'
);

CREATE TABLE IF NOT EXISTS im_interactive_chats (
  source       TEXT    NOT NULL,             -- 'slack' | 'telegram' | ...
  external_id  TEXT    NOT NULL,             -- IM-native chat id (Slack channel / TG chat)
  chat_id      INTEGER NOT NULL,             -- internal chats.id
  created_at   INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (source, external_id)
);

CREATE INDEX IF NOT EXISTS idx_im_interactive_chats_chat
ON im_interactive_chats(chat_id);

CREATE TABLE IF NOT EXISTS memory_maintenance_config (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  enabled             INTEGER NOT NULL DEFAULT 1,
  schedule_time       TEXT    NOT NULL DEFAULT '04:00',
  provider_id         TEXT,
  model_id            TEXT,
  layer1_enabled      INTEGER NOT NULL DEFAULT 1,
  max_sessions_per_run INTEGER NOT NULL DEFAULT 50,
  updated_at          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_maintenance_runs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at         INTEGER NOT NULL,
  finished_at        INTEGER,
  layer              TEXT NOT NULL CHECK (layer IN ('extract', 'consolidate', 'full')),
  provider_id        TEXT,
  model_id           TEXT,
  sessions_processed INTEGER NOT NULL DEFAULT 0,
  chunks_processed   INTEGER NOT NULL DEFAULT 0,
  memories_written   INTEGER NOT NULL DEFAULT 0,
  memories_merged    INTEGER NOT NULL DEFAULT 0,
  tokens_input       INTEGER NOT NULL DEFAULT 0,
  tokens_output      INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL CHECK (status IN ('running', 'success', 'error', 'aborted')),
  trigger            TEXT NOT NULL DEFAULT 'scheduled' CHECK (trigger IN ('scheduled', 'manual')),
  error              TEXT
);

CREATE INDEX IF NOT EXISTS idx_memory_maintenance_runs_started
ON memory_maintenance_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS "im_providers" (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  source            TEXT    NOT NULL,
  instance_id       TEXT    NOT NULL,
  mode              TEXT    NOT NULL
    CHECK (mode IN ('interactive', 'mate')),
  agent_id          INTEGER,
  self_user_id      TEXT    NOT NULL,
  self_bot_id       TEXT,
  display_name      TEXT    NOT NULL,
  credentials_json  TEXT    NOT NULL,
  config_json       TEXT,
  enabled           INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  UNIQUE (source, instance_id),
  CHECK (
    (mode = 'mate'        AND agent_id IS NOT NULL) OR
    (mode = 'interactive' AND agent_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_im_providers_agent
ON im_providers(agent_id);

CREATE INDEX IF NOT EXISTS idx_im_providers_self
ON im_providers(source, self_user_id);

CREATE TABLE IF NOT EXISTS chat_mobile_pairings (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  desktop_id          TEXT NOT NULL,
  mobile_device_id    TEXT NOT NULL,
  mobile_public_key   BLOB NOT NULL,
  mobile_fingerprint  TEXT NOT NULL,
  mobile_label        TEXT,
  pairing_nonce       TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('pending','confirmed','revoked')),
  created_at          INTEGER NOT NULL,
  confirmed_at        INTEGER,
  revoked_at          INTEGER,
  last_seen_at        INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_mobile_pairings_identity
  ON chat_mobile_pairings(desktop_id, mobile_device_id);

CREATE INDEX IF NOT EXISTS idx_chat_mobile_pairings_status
  ON chat_mobile_pairings(status, created_at);

CREATE INDEX IF NOT EXISTS idx_chat_mobile_pairings_nonce
  ON chat_mobile_pairings(pairing_nonce);

CREATE TABLE IF NOT EXISTS agent_message_cursors (
  agent_id     INTEGER NOT NULL,
  stream_kind  TEXT    NOT NULL CHECK (stream_kind IN ('app', 'mate', 'inbox')),
  stream_key   TEXT    NOT NULL,
  last_read_id INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (agent_id, stream_kind, stream_key)
);

CREATE TABLE IF NOT EXISTS agent_inbox_messages (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient_agent_id  INTEGER NOT NULL,                       -- agents(id)
  sender_agent_id     INTEGER,                                -- agents(id), nullable for system-generated
  sender_name         TEXT    NOT NULL,                       -- denormalised for display
  content             TEXT    NOT NULL,
  ref_kind            TEXT,                                   -- 'linear_issue' | (future: 'channel_task' | ...)
  ref_id              TEXT,                                   -- e.g. 'ENG-123'
  metadata            TEXT,                                   -- JSON for future extension fields
  created_at          INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_agent_inbox_recipient
ON agent_inbox_messages(recipient_agent_id, id);

CREATE INDEX IF NOT EXISTS idx_agent_inbox_ref
ON agent_inbox_messages(ref_kind, ref_id) WHERE ref_kind IS NOT NULL;

CREATE TABLE IF NOT EXISTS "im_messages" (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient_agent_id   INTEGER,                                -- NULL for legacy rows; required for new writes
  source               TEXT    NOT NULL,
  source_channel       TEXT    NOT NULL,
  source_ts            TEXT    NOT NULL,
  sender_kind          TEXT    NOT NULL
    CHECK (sender_kind IN ('human', 'external_bot', 'self_bot')),
  sender_id            TEXT    NOT NULL,
  sender_name          TEXT    NOT NULL,
  sender_agent_id      INTEGER,
  text                 TEXT    NOT NULL,
  thread_ref           TEXT,
  reply_to_ref         TEXT,
  attachments_json     TEXT,
  raw_json             TEXT,
  received_at          INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  -- New natural key: per-bot message_id is unique within (recipient, channel).
  -- Legacy rows have recipient_agent_id IS NULL — SQLite treats NULL as
  -- distinct so they won't be retroactively de-duped (and they won't be
  -- queryable through the new filter either; see deletion comment below).
  UNIQUE (recipient_agent_id, source, source_channel, source_ts)
);

CREATE INDEX IF NOT EXISTS idx_im_messages_lookup
ON im_messages(source, source_channel, id);

CREATE INDEX IF NOT EXISTS idx_im_messages_thread
ON im_messages(source, source_channel, thread_ref, id);

CREATE INDEX IF NOT EXISTS idx_im_messages_recipient
ON im_messages(recipient_agent_id, source, source_channel, id)
WHERE recipient_agent_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS tasks (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id        INTEGER NOT NULL,                -- logical ref: projects(id)
  number            INTEGER NOT NULL,                -- per-project sequential (#1, #2, ... → OP-42)
  title             TEXT    NOT NULL,
  description       TEXT    NOT NULL DEFAULT '',     -- markdown spec the agent works from
  status            TEXT    NOT NULL DEFAULT 'todo'
    CHECK(status IN ('todo', 'in_progress', 'in_review', 'done', 'cancelled')),
  priority          INTEGER NOT NULL DEFAULT 0       -- 0 none, 1 low, 2 medium, 3 high, 4 urgent (DESC = urgent first)
    CHECK(priority BETWEEN 0 AND 4),
  assigned_agent_id INTEGER,                         -- logical ref: agents(id); NULL = unassigned
  parent_task_id    INTEGER,                         -- logical ref: tasks(id); reserved for sub-tasks (P2)
  source_channel_id INTEGER,                         -- logical ref: channels(id); where captured (NULL = standalone)
  source_message_id INTEGER,                         -- logical ref: channel_messages(id); NULL = not from a message
  branch_name       TEXT,                            -- git branch for this task
  workspace_id      INTEGER,                         -- logical ref: workspaces(id); per-task worktree
  binding_id        INTEGER,                         -- logical ref: agent_bindings(id); set when dispatched
  created_by        TEXT    NOT NULL DEFAULT 'human'
    CHECK(created_by IN ('human', 'agent')),
  created_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000), team_id INTEGER, archived_at INTEGER, sdd_managed INTEGER NOT NULL DEFAULT 0, spec_author_agent_id INTEGER, plan_anchor TEXT, claimed_acs TEXT, source_chat_id INTEGER,
  UNIQUE (project_id, number)
);

CREATE INDEX IF NOT EXISTS idx_tasks_project_status
ON tasks(project_id, status);

CREATE INDEX IF NOT EXISTS idx_tasks_assignee
ON tasks(assigned_agent_id) WHERE assigned_agent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_parent
ON tasks(parent_task_id) WHERE parent_task_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS task_label_defs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL,                      -- logical ref: projects(id)
  name        TEXT    NOT NULL,
  color       TEXT    NOT NULL DEFAULT '#888888',
  is_team     INTEGER NOT NULL DEFAULT 0,            -- 1 = team-scope label (inbox peer grouping)
  created_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  UNIQUE (project_id, name)
);

CREATE TABLE IF NOT EXISTS task_labels (
  task_id   INTEGER NOT NULL,                        -- logical ref: tasks(id)
  label_id  INTEGER NOT NULL,                        -- logical ref: task_label_defs(id)
  PRIMARY KEY (task_id, label_id)
);

CREATE INDEX IF NOT EXISTS idx_task_labels_label
ON task_labels(label_id);

CREATE TABLE IF NOT EXISTS agent_bindings (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id                 INTEGER NOT NULL,

  scope_kind               TEXT    NOT NULL                   -- 'app' | 'slack' | 'telegram' | 'linear' | 'task'
    CHECK (scope_kind IN ('app', 'slack', 'telegram', 'linear', 'task')),
  scope_key                TEXT    NOT NULL,                  -- app: channel.id; linear: agent_session_id; task: task.id
  scope_display_name       TEXT,
  channel_kind             TEXT    NOT NULL DEFAULT 'channel'
    CHECK (channel_kind IN ('channel', 'dm')),

  project_id               INTEGER,
  workspace_id             INTEGER,
  active_chat_id           INTEGER,
  status                   TEXT    NOT NULL DEFAULT 'offline'
    CHECK (status IN ('offline', 'idle', 'active', 'completed')),

  im_provider_instance_id  INTEGER,
  agent_session_id         TEXT,
  team_label               TEXT,
  metadata                 TEXT,

  created_at               INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at               INTEGER NOT NULL DEFAULT (unixepoch() * 1000),

  UNIQUE (scope_kind, scope_key, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_bindings_agent_status
ON agent_bindings(agent_id, status);

CREATE INDEX IF NOT EXISTS idx_agent_bindings_project_kind_status
ON agent_bindings(project_id, scope_kind, status);

CREATE INDEX IF NOT EXISTS idx_agent_bindings_active_chat
ON agent_bindings(active_chat_id) WHERE active_chat_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_bindings_im_provider
ON agent_bindings(im_provider_instance_id) WHERE im_provider_instance_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_bindings_agent_session
ON agent_bindings(agent_session_id) WHERE agent_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_bindings_team
ON agent_bindings(team_label, status) WHERE team_label IS NOT NULL;

CREATE TABLE IF NOT EXISTS teams (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL,                       -- logical ref: projects(id)
  name        TEXT    NOT NULL,
  color       TEXT    NOT NULL DEFAULT '#8b5cf6',
  created_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  UNIQUE (project_id, name)
);

CREATE INDEX IF NOT EXISTS idx_tasks_team
ON tasks(team_id) WHERE team_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_project_archived
ON tasks(project_id, archived_at);

CREATE TABLE IF NOT EXISTS task_artifacts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id          INTEGER NOT NULL,                  -- logical ref: tasks(id)
  kind             TEXT    NOT NULL                   -- 门禁只读 status,不读正文
    CHECK(kind IN ('spec', 'plan', 'acceptance', 'spec_delta')),
  status           TEXT    NOT NULL DEFAULT 'draft'
    CHECK(status IN ('draft', 'approved')),
  approved_by_type TEXT                               -- 'human' | 'agent'; NULL = 未签
    CHECK(approved_by_type IN ('human', 'agent')),
  approved_by      INTEGER,                            -- actor id(agents(id) / user id);NULL = 未签
  approved_at      INTEGER,
  content_ref      TEXT,                               -- change 分支上的文件路径;物化前为 NULL
  content_sha      TEXT,                               -- 签收那刻的 git blob sha(drift 检测)
  updated_at       INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  UNIQUE (task_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_task_artifacts_task
ON task_artifacts(task_id);

CREATE TABLE IF NOT EXISTS memory_alias (
  type TEXT NOT NULL,
  alias_key TEXT NOT NULL,
  page_slug TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (type, alias_key)
);

CREATE INDEX IF NOT EXISTS idx_memory_alias_page ON memory_alias(type, page_slug);

CREATE TABLE IF NOT EXISTS memory_timeline (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_type TEXT NOT NULL,
  page_slug TEXT NOT NULL,
  entry TEXT NOT NULL,
  occurred_at INTEGER,            -- NULL = event time unknown
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_timeline_page
  ON memory_timeline(page_type, page_slug, occurred_at DESC);

CREATE TRIGGER IF NOT EXISTS memory_timeline_ai AFTER INSERT ON memory_timeline BEGIN
  INSERT INTO memory_timeline_fts(rowid, entry) VALUES (new.id, new.entry);
END;

CREATE TRIGGER IF NOT EXISTS memory_timeline_ad AFTER DELETE ON memory_timeline BEGIN
  INSERT INTO memory_timeline_fts(memory_timeline_fts, rowid, entry)
  VALUES ('delete', old.id, old.entry);
END;

CREATE TABLE IF NOT EXISTS task_activity (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     INTEGER NOT NULL,                      -- logical ref: tasks(id)
  kind        TEXT    NOT NULL
    CHECK(kind IN ('comment', 'status', 'assign', 'dispatch', 'branch', 'system', 'verify', 'gate')),
  actor_type  TEXT    NOT NULL
    CHECK(actor_type IN ('human', 'agent', 'system')),
  actor_id    INTEGER,                               -- agents(id) / user id; NULL for system
  actor_name  TEXT    NOT NULL,                      -- denormalised display name
  body        TEXT    NOT NULL DEFAULT '',           -- comment text or rendered event detail
  meta        TEXT,                                  -- JSON: status {from,to}; branch {pr}; etc.
  created_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_task_activity_task
ON task_activity(task_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_project_name
ON channels(project_id, name);

CREATE TABLE IF NOT EXISTS notifications (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT    NOT NULL,   -- chat_complete|chat_needs_input|task_in_review|task_done|task_failed|sdd_gate|cron_done
  severity      TEXT    NOT NULL,   -- 'action' (needs you) | 'info' (fyi)
  project_id    INTEGER,
  workspace_id  INTEGER,
  chat_id       INTEGER,
  task_id       INTEGER,
  agent_id      INTEGER,
  title         TEXT    NOT NULL,
  body          TEXT,
  source_key    TEXT    NOT NULL,   -- 'chat:42' | 'task:17'
  read_at       INTEGER,            -- NULL = unread
  archived_at   INTEGER,            -- NULL = visible; dismissed → set
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notifications_inbox
  ON notifications(archived_at, read_at, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_source
  ON notifications(source_key) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS workflow_events (
  -- Globally monotonic, so one cursor works for both the global feed and a
  -- single run's feed (`since=<id>` on reconnect).
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT    NOT NULL,
  ts     INTEGER NOT NULL,
  -- started | phase | agent | chunk | approval | approval-resolved | log
  -- | journal | truncated | settled | dismissed
  kind   TEXT    NOT NULL,
  -- JSON payload; shape per kind (services/workflow/events.ts).
  data   TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_events_run ON workflow_events(run_id, id);

CREATE INDEX IF NOT EXISTS idx_workflow_events_run_kind ON workflow_events(run_id, kind, id);

CREATE TABLE IF NOT EXISTS workflow_run_index (
  run_id      TEXT PRIMARY KEY,
  chat_id     INTEGER,
  name        TEXT    NOT NULL,
  status      TEXT    NOT NULL,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  sort_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_run_index_sort ON workflow_run_index(sort_at DESC);

CREATE TABLE IF NOT EXISTS memory_page (
  type TEXT NOT NULL CHECK(type IN ('user','entities','events','cases')),
  slug TEXT NOT NULL,
  truth TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (type, slug)
);

CREATE INDEX IF NOT EXISTS idx_memory_page_type ON memory_page(type);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_page_fts USING fts5(
  truth,
  content='memory_page',
  content_rowid='rowid',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS memory_page_ai AFTER INSERT ON memory_page BEGIN
  INSERT INTO memory_page_fts(rowid, truth) VALUES (new.rowid, new.truth);
END;

CREATE TRIGGER IF NOT EXISTS memory_page_ad AFTER DELETE ON memory_page BEGIN
  INSERT INTO memory_page_fts(memory_page_fts, rowid, truth)
  VALUES ('delete', old.rowid, old.truth);
END;

CREATE TRIGGER IF NOT EXISTS memory_page_au AFTER UPDATE ON memory_page BEGIN
  INSERT INTO memory_page_fts(memory_page_fts, rowid, truth)
  VALUES ('delete', old.rowid, old.truth);
  INSERT INTO memory_page_fts(rowid, truth) VALUES (new.rowid, new.truth);
END;

-- Seed: memory-maintenance config singleton (id=1).
INSERT OR IGNORE INTO memory_maintenance_config (id, updated_at)
VALUES (1, unixepoch() * 1000);
