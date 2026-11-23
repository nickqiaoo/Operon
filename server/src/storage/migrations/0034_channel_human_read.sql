-- Where the person (single-user instance) has read up to, per channel and per
-- thread — the sidebar's unread counts. Agents keep their own cursors in
-- agent_message_cursors; this is the human's. channel_messages.id is a global
-- monotonic seq, so "unread" is just id > cursor.
--
-- A thread's cursor lives on its root message, not on channel_threads: a thread
-- can have replies before it has a row, and creating a row just to hold a cursor
-- would change who owns it (ensureThreadForHumanReply only assigns the root's
-- author when there is no row yet).

ALTER TABLE channels ADD COLUMN human_last_read_id INTEGER NOT NULL DEFAULT 0;
-- Root messages only; NULL-free so `id > cursor` needs no COALESCE.
ALTER TABLE channel_messages ADD COLUMN human_thread_read_id INTEGER NOT NULL DEFAULT 0;

-- Everything before this upgrade counts as read: otherwise every old channel
-- lights up at once.
UPDATE channels SET human_last_read_id = COALESCE(
  (SELECT MAX(id) FROM channel_messages m WHERE m.channel_id = channels.id), 0);
UPDATE channel_messages SET human_thread_read_id = COALESCE(
  (SELECT MAX(r.id) FROM channel_messages r WHERE r.thread_root_id = channel_messages.id), 0)
WHERE thread_root_id IS NULL AND reply_count > 0;

-- Only agents' messages are unread for the person (their own and system notices
-- never are), so the counts scan just those rows, straight off the index.
CREATE INDEX IF NOT EXISTS idx_messages_agent_main
ON channel_messages(channel_id, id) WHERE thread_root_id IS NULL AND sender_type = 'agent';

CREATE INDEX IF NOT EXISTS idx_messages_agent_reply
ON channel_messages(thread_root_id, id) WHERE thread_root_id IS NOT NULL AND sender_type = 'agent';

-- The roots that have a thread, so the per-thread counts don't scan every message.
CREATE INDEX IF NOT EXISTS idx_messages_thread_roots
ON channel_messages(channel_id) WHERE thread_root_id IS NULL AND reply_count > 0;
