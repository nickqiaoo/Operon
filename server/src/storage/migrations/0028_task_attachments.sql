-- Images attached to a task's description, as a JSON array of
-- { url, mediaType, filename? } (url = /api/attachments/<sha256>). NULL = none.
-- Comment images live on the activity row's meta.attachments instead.
ALTER TABLE tasks ADD COLUMN attachments TEXT;
