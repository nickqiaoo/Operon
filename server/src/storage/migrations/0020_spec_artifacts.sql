-- Display snapshots for newly written Spec documents. No historical backfill.
CREATE TABLE spec_artifacts (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, path)
);
