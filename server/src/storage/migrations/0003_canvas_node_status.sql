-- Canvas node results learn two more states: 'skipped' (a branch the run did
-- not take, or downstream of a failed node) and 'waiting' (paused on a human
-- approval). SQLite cannot alter a CHECK in place, so rebuild the table;
-- 0001 keeps creating the old shape for fresh databases and this migration
-- immediately upgrades it (a rebuild of an empty table is harmless).

CREATE TABLE canvas_node_results_v2 (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      INTEGER NOT NULL,
  node_id     TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('pending', 'running', 'success', 'error', 'skipped', 'waiting')),
  output      TEXT,
  error       TEXT,
  started_at  INTEGER,
  finished_at INTEGER,
  UNIQUE (run_id, node_id)
);

INSERT INTO canvas_node_results_v2 (id, run_id, node_id, status, output, error, started_at, finished_at)
SELECT id, run_id, node_id, status, output, error, started_at, finished_at FROM canvas_node_results;

DROP INDEX IF EXISTS idx_canvas_run_nodes;
DROP TABLE canvas_node_results;
ALTER TABLE canvas_node_results_v2 RENAME TO canvas_node_results;

CREATE INDEX IF NOT EXISTS idx_canvas_run_nodes
ON canvas_node_results(run_id, node_id);
