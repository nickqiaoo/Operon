-- Every workflow run a spec has had, oldest first (JSON array of run ids).
--
-- A spec's design stage runs in segments: each start, resume or request for
-- changes is its own workflow run, and `workflow_run_id` only keeps the latest.
-- The progress card lists every agent the spec ran and what it cost in calls
-- and time, so it needs them all.
ALTER TABLE spec_runs ADD COLUMN run_ids TEXT NOT NULL DEFAULT '[]';

UPDATE spec_runs SET run_ids = json_array(workflow_run_id) WHERE workflow_run_id IS NOT NULL;
