-- Where a dispatched task runs: NULL = its own new worktree (the default and
-- every existing task), 'shared' = an existing workspace it does not own — no
-- branch of its own, nothing merged or removed on Done.
ALTER TABLE tasks ADD COLUMN workspace_mode TEXT CHECK (workspace_mode IS NULL OR workspace_mode = 'shared');
