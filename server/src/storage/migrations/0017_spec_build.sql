-- OperonSpec build stage: after gate 1 the spec's tickets are built, reviewed by
-- another model family and merged into the change branch, one event at a time.
-- Each ticket's place in that (implementer, reviewer, review rounds, blocked…)
-- is kept here as a JSON array of SpecTicketBuild, next to the rulings column
-- 0015 already reserved.
ALTER TABLE spec_runs ADD COLUMN build TEXT NOT NULL DEFAULT '[]';

-- `approved` was where a signed spec stopped before the build stage existed;
-- its tickets are dispatched by hand, which the build stage still allows.
UPDATE spec_runs SET stage = 'building' WHERE stage = 'approved';
