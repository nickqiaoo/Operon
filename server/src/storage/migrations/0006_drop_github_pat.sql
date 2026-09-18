-- PRs opened from the review toolbar now go through the user's own `gh` login
-- (services/integrations/gh-cli.ts), so operon no longer holds a GitHub
-- credential of its own. Nothing reads this key any more, and leaving it would
-- keep a personal access token sitting in the database in plain text after the
-- feature that asked for it is gone.

DELETE FROM kv WHERE key = 'integration:github';
