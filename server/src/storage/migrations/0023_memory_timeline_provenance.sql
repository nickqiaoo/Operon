-- Timeline provenance.
--
-- Until now memory_upsert stored the writer's `reason` ("why this is worth
-- remembering") as the timeline `entry`, and the incoming `content` (what was
-- actually learned) went nowhere once it was merged into the truth. The entry
-- now carries the content — what happened / what changed — and the two
-- provenance fields sit beside it, out of the FTS / vector index:
--   reason — the evidence the writer relied on (ideally the user's own words)
--   source — where it came from, filled by the caller (e.g. "chat:123")
-- Existing rows keep their old entry; both new columns stay NULL for them.

ALTER TABLE memory_timeline ADD COLUMN reason TEXT;
ALTER TABLE memory_timeline ADD COLUMN source TEXT;
