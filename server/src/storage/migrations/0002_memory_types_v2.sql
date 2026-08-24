-- Memory type taxonomy v2 rebuild.
--
-- 0001_schema.sql already creates memory_page with the 4-type CHECK for fresh
-- databases, but databases upgrading from released builds (<= 1.3.23, migrated
-- through the old 0042) still carry the pre-squash 6-type CHECK
-- ('profile','preferences','entities','events','cases','patterns') — and
-- IF NOT EXISTS in 0001 deliberately leaves existing tables alone. Without this
-- rebuild every write of type 'user' on an upgraded database fails the CHECK.
--
-- So rebuild memory_page unconditionally (on a fresh database this recreates
-- the just-created empty table — harmless). Existing memory data is
-- intentionally DROPPED, not migrated: trial-period data, and the old types
-- (profile/preferences/patterns) no longer exist to migrate into.

DROP TRIGGER IF EXISTS memory_page_ai;
DROP TRIGGER IF EXISTS memory_page_ad;
DROP TRIGGER IF EXISTS memory_page_au;

DROP TABLE IF EXISTS memory_page_fts;
DROP TABLE IF EXISTS memory_page;

CREATE TABLE memory_page (
  type TEXT NOT NULL CHECK(type IN ('user','entities','events','cases')),
  slug TEXT NOT NULL,
  truth TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (type, slug)
);

CREATE INDEX IF NOT EXISTS idx_memory_page_type ON memory_page(type);

CREATE VIRTUAL TABLE memory_page_fts USING fts5(
  truth,
  content='memory_page',
  content_rowid='rowid',
  tokenize='trigram'
);

CREATE TRIGGER memory_page_ai AFTER INSERT ON memory_page BEGIN
  INSERT INTO memory_page_fts(rowid, truth) VALUES (new.rowid, new.truth);
END;

CREATE TRIGGER memory_page_ad AFTER DELETE ON memory_page BEGIN
  INSERT INTO memory_page_fts(memory_page_fts, rowid, truth)
  VALUES ('delete', old.rowid, old.truth);
END;

CREATE TRIGGER memory_page_au AFTER UPDATE ON memory_page BEGIN
  INSERT INTO memory_page_fts(memory_page_fts, rowid, truth)
  VALUES ('delete', old.rowid, old.truth);
  INSERT INTO memory_page_fts(rowid, truth) VALUES (new.rowid, new.truth);
END;

-- Timeline + alias entries belonged to the dropped pages; clear them too.
-- (DELETE, not DROP — the timeline FTS triggers keep its index in sync.)
DELETE FROM memory_timeline;
DELETE FROM memory_alias;
