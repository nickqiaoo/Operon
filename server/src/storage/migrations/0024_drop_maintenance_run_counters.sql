-- Drop dead counters from memory-maintenance runs.
--   tokens_input / tokens_output — summed from per-step provider usage, which
--     several providers never report (ACP runs always read 0); not worth keeping.
--   memories_merged — cross-page merging moved into memory_upsert at write time,
--     so the column has been written as 0 ever since.

ALTER TABLE memory_maintenance_runs DROP COLUMN tokens_input;
ALTER TABLE memory_maintenance_runs DROP COLUMN tokens_output;
ALTER TABLE memory_maintenance_runs DROP COLUMN memories_merged;
