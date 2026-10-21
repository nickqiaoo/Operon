-- SDD v2 is gone. Its spec/plan/acceptance gate rows (task_artifacts) and the
-- task columns only it read — the sdd_managed flag, the recorded spec author,
-- a subtask's plan anchor and claimed AC ids — have no reader left. A spec is
-- now a task with a spec_runs row, its files live on its change branch, and
-- design.md's signed sha sits in spec_runs.design_sha. The old v2 tasks stay as
-- ordinary tasks; the files on their branches are left where they are.

DROP INDEX IF EXISTS idx_task_artifacts_task;
DROP TABLE IF EXISTS task_artifacts;

ALTER TABLE tasks DROP COLUMN sdd_managed;
ALTER TABLE tasks DROP COLUMN spec_author_agent_id;
ALTER TABLE tasks DROP COLUMN plan_anchor;
ALTER TABLE tasks DROP COLUMN claimed_acs;
