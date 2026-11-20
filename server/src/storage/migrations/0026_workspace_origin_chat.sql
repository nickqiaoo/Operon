-- The conversation that made a workspace for an external agent it dispatched (the
-- `workspace_create` tool). The sidebar lists such a workspace under that
-- conversation instead of beside the user's own. Logical ref: chats(id). Null: the
-- user, a spec or a board task made it.
ALTER TABLE workspaces ADD COLUMN origin_chat_id INTEGER;

-- Workspaces made that way before the column existed: they hold only external-agent
-- conversations started from a chat in another workspace, and no board task.
UPDATE workspaces
SET origin_chat_id = (
  SELECT CAST(json_extract(c.metadata, '$.externalAgent.parentChatId') AS INTEGER)
  FROM chats c
  JOIN chats p ON p.id = json_extract(c.metadata, '$.externalAgent.parentChatId')
  WHERE c.workspace_id = workspaces.id
    AND c.tp = 'subagent'
    AND p.workspace_id IS NOT workspaces.id
  ORDER BY c.id
  LIMIT 1
)
WHERE origin_chat_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM chats o WHERE o.workspace_id = workspaces.id AND o.tp <> 'subagent')
  AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.workspace_id = workspaces.id);
