-- Task teams are gone. A team grouped sibling subtasks' agents into a private
-- inbox so they could message each other mid-run; in practice nobody used it,
-- and the spec workflow that replaces SDD v2 coordinates through its
-- orchestrator instead of agent-to-agent messages. This removes the team scope
-- (teams, tasks.team_id, agent_bindings.team_label, the team-scope label flag)
-- and the agent inbox it carried. Not related to the Teams (peers) extension.

DROP INDEX IF EXISTS idx_tasks_team;
ALTER TABLE tasks DROP COLUMN team_id;

DROP INDEX IF EXISTS idx_agent_bindings_team;
ALTER TABLE agent_bindings DROP COLUMN team_label;

ALTER TABLE task_label_defs DROP COLUMN is_team;

DROP TABLE IF EXISTS teams;

DROP INDEX IF EXISTS idx_agent_inbox_recipient;
DROP INDEX IF EXISTS idx_agent_inbox_ref;
DROP TABLE IF EXISTS agent_inbox_messages;
DELETE FROM agent_message_cursors WHERE stream_kind = 'inbox';
