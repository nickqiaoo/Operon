-- A project the user pinned to the top of the sidebar, and when: pinned projects list first,
-- in the order they were pinned. Null: not pinned.
ALTER TABLE projects ADD COLUMN pinned_at INTEGER;
