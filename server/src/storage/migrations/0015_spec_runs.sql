-- OperonSpec (spec workflow v3): one row per spec parent task, carrying the
-- stage the change is in and who plays each role. The design artifacts
-- themselves (brief, grounding, candidates, design, tickets…) are files on the
-- task's change branch; this row only says where the run stands.
--
-- `stage` is validated in TypeScript (services/spec/types.ts), not with a CHECK:
-- later phases add stages, and SQLite cannot alter a CHECK in place.
CREATE TABLE IF NOT EXISTS spec_runs (
  task_id          INTEGER PRIMARY KEY,           -- logical ref: tasks(id)
  stage            TEXT    NOT NULL,
  config           TEXT    NOT NULL,              -- JSON SpecRunConfig: provider per role
  design_sha       TEXT,                          -- design.md blob sha signed at gate 1
  workflow_run_id  TEXT,                          -- the run whose events show this stage's progress
  error            TEXT,                          -- why the last run stopped short, if it did
  rulings          TEXT    NOT NULL DEFAULT '[]', -- JSON: implementers' recorded rulings (build stage)
  created_at       INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at       INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- A spec ticket's blockers: JSON array of sibling task ids that must finish first.
ALTER TABLE tasks ADD COLUMN blocked_by TEXT;
