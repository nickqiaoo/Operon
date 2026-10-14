-- A coding agent the assistant started in one of the user's workspaces: which conversation,
-- where, and its last state (docs/assistant/operon-manager.md). json ActivityCoding; null for
-- the assistant's own workers and turns.
ALTER TABLE assistant_activities ADD COLUMN coding_json TEXT;
