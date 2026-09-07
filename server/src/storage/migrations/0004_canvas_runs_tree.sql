-- Canvas workflows grow settings (webhook trigger) and runs grow a tree:
-- iteration / loop bodies and sub-workflows run as child runs under the run
-- that started them, so the history keeps every round without flooding the
-- top-level list.

ALTER TABLE canvas_workflows ADD COLUMN settings TEXT;

ALTER TABLE canvas_workflow_runs ADD COLUMN parent_run_id INTEGER;
ALTER TABLE canvas_workflow_runs ADD COLUMN iteration INTEGER;
ALTER TABLE canvas_workflow_runs ADD COLUMN trigger TEXT;

CREATE INDEX IF NOT EXISTS idx_canvas_runs_parent
ON canvas_workflow_runs(parent_run_id);
