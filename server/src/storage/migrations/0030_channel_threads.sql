-- Channel threads become units of work with an owner. A thread is backed by its
-- own agent session (a 'thread' binding, scope_key = root message id), separate
-- from the agent's channel session: the channel session hands work off with
-- open_thread, the thread session does it and reports back with update_thread.
--
-- channel_threads holds the thread's owner and reported state. It is keyed by
-- the root message, so "one thread per message, first claim wins" is the
-- primary key. No foreign keys (project rule) — all refs are logical.

CREATE TABLE IF NOT EXISTS channel_threads (
  root_message_id INTEGER PRIMARY KEY,               -- logical ref: channel_messages(id)
  channel_id      INTEGER NOT NULL,                  -- logical ref: channels(id)
  owner_agent_id  INTEGER,                           -- logical ref: agents(id); NULL = nobody has taken it
  status          TEXT    NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'waiting', 'done')),
  summary         TEXT    NOT NULL DEFAULT '',
  created_by_type TEXT    NOT NULL CHECK (created_by_type IN ('human', 'agent')),
  created_by_id   INTEGER,                           -- agents(id) when created_by_type = 'agent'
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_channel_threads_channel
ON channel_threads(channel_id, updated_at);

-- Existing threads (roots with replies) get a row with no owner: the next reply
-- in them goes to the channel sessions, and whoever takes it claims it.
INSERT OR IGNORE INTO channel_threads
  (root_message_id, channel_id, owner_agent_id, status, summary, created_by_type, created_by_id, created_at, updated_at)
SELECT id, channel_id, NULL, 'open', '', 'human', NULL, created_at, COALESCE(last_reply_at, created_at)
FROM channel_messages
WHERE thread_root_id IS NULL AND reply_count > 0;

-- Which session posted an agent message. Unread is per session now (an agent's
-- channel session and its thread sessions read each other's messages), so "your
-- own message" is the session's, not the agent's. NULL on older rows and on
-- human/system messages; those fall back to the sender agent.
ALTER TABLE channel_messages ADD COLUMN sender_binding_id INTEGER;

-- agent_bindings learns scope_kind 'thread'. SQLite cannot alter a CHECK in
-- place, so rebuild the table (same columns as after 0014).
CREATE TABLE agent_bindings_v2 (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id                 INTEGER NOT NULL,

  scope_kind               TEXT    NOT NULL                   -- 'app' | 'slack' | 'telegram' | 'linear' | 'task' | 'thread'
    CHECK (scope_kind IN ('app', 'slack', 'telegram', 'linear', 'task', 'thread')),
  scope_key                TEXT    NOT NULL,                  -- app: channel.id; linear: agent_session_id; task: task.id; thread: root message id
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
  metadata                 TEXT,

  created_at               INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at               INTEGER NOT NULL DEFAULT (unixepoch() * 1000),

  UNIQUE (scope_kind, scope_key, agent_id)
);

INSERT INTO agent_bindings_v2
  (id, agent_id, scope_kind, scope_key, scope_display_name, channel_kind, project_id, workspace_id,
   active_chat_id, status, im_provider_instance_id, agent_session_id, metadata, created_at, updated_at)
SELECT
   id, agent_id, scope_kind, scope_key, scope_display_name, channel_kind, project_id, workspace_id,
   active_chat_id, status, im_provider_instance_id, agent_session_id, metadata, created_at, updated_at
FROM agent_bindings;

DROP INDEX IF EXISTS idx_agent_bindings_agent_status;
DROP INDEX IF EXISTS idx_agent_bindings_project_kind_status;
DROP INDEX IF EXISTS idx_agent_bindings_active_chat;
DROP INDEX IF EXISTS idx_agent_bindings_im_provider;
DROP INDEX IF EXISTS idx_agent_bindings_agent_session;
DROP TABLE agent_bindings;
ALTER TABLE agent_bindings_v2 RENAME TO agent_bindings;

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

-- Read cursors learn stream_kind 'thread' (stream_key = root message id). The
-- 'inbox' kind is gone since 0014.
CREATE TABLE agent_message_cursors_v2 (
  agent_id     INTEGER NOT NULL,
  stream_kind  TEXT    NOT NULL CHECK (stream_kind IN ('app', 'mate', 'thread')),
  stream_key   TEXT    NOT NULL,
  last_read_id INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (agent_id, stream_kind, stream_key)
);

INSERT INTO agent_message_cursors_v2 (agent_id, stream_kind, stream_key, last_read_id, updated_at)
SELECT agent_id, stream_kind, stream_key, last_read_id, updated_at
FROM agent_message_cursors
WHERE stream_kind IN ('app', 'mate');

DROP TABLE agent_message_cursors;
ALTER TABLE agent_message_cursors_v2 RENAME TO agent_message_cursors;
