-- Images on a channel message (main channel or thread), as a JSON array of
-- { url, mediaType, filename? } (url = /api/attachments/<sha256>). NULL = none.
-- Humans attach them in the composer; agents attach local image files through
-- send_message's `images`, which the server copies into the attachment store.
ALTER TABLE channel_messages ADD COLUMN attachments TEXT;
