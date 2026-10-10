-- An approval card is a message in the thread; its request and answer ride along.
ALTER TABLE assistant_messages ADD COLUMN approval_json TEXT;
