-- Who named the workspace: 'user' (typed, or made by a task / spec / agent —
-- every existing workspace), 'placeholder' (a chat's worktree made before
-- anyone said what it is for; the server names it from the chat's messages) or
-- 'auto' (that generated name went in). Only 'placeholder' is ever renamed.
ALTER TABLE workspaces ADD COLUMN name_source TEXT NOT NULL DEFAULT 'user' CHECK (name_source IN ('user', 'placeholder', 'auto'));
