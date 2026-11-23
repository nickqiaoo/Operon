-- The reasoning effort an agent's sessions run at (the provider's thought_level
-- option, e.g. 'low' / 'high' / 'max'). '' means the provider's own default.
ALTER TABLE agents ADD COLUMN thinking_level TEXT NOT NULL DEFAULT '';
