-- OperonSpec: a switch of agent the spec's coordinator asks the user for (an
-- agent out of quota, one that will not start), kept until the user takes it or
-- turns it down. JSON SpecSwitchProposal, NULL when there is none.
ALTER TABLE spec_runs ADD COLUMN proposal TEXT;
