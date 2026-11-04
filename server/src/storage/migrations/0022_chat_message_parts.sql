-- A message is stored as a head row plus one row per part.
--
-- A running turn saves its reply as it goes. With the whole reply in one JSON
-- column every save rewrote all of it, so a long turn wrote its own size over
-- and over (tool output is ~90% of the bytes). With a row per part a save
-- writes only the parts that changed.
--
-- `head` is the message without `parts` (id, role, metadata…). Parts are keyed
-- by their position in `parts`, which never changes once a part is added: the
-- AI SDK only appends parts or updates them in place.
--
-- `message_index` orders a chat's messages and may have gaps. A message is
-- identified by its id (`uid`), which is now unique within a chat. Rows with an
-- empty uid, repeated uids (all but the latest copy), and rows whose chat is
-- gone are dropped. No foreign keys: deleting a chat deletes its rows in code.
--
-- `chats.revision` goes too: nothing compared against it any more.

CREATE TABLE chat_messages_v2 (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id       INTEGER NOT NULL,
  uid           TEXT NOT NULL CHECK (uid <> ''),
  message_index INTEGER NOT NULL,
  head          TEXT NOT NULL,
  UNIQUE (chat_id, uid),
  UNIQUE (chat_id, message_index)
);

CREATE TABLE chat_message_parts (
  id         INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL,
  idx        INTEGER NOT NULL,
  payload    TEXT NOT NULL,
  UNIQUE (message_id, idx)
);

INSERT INTO chat_messages_v2 (id, chat_id, uid, message_index, head)
SELECT id, chat_id, uid, message_index, json_remove(payload, '$.parts')
FROM (
  SELECT m.*, ROW_NUMBER() OVER (PARTITION BY chat_id, uid ORDER BY message_index DESC) AS copy
  FROM chat_messages m
  WHERE uid <> ''
    AND json_valid(payload)
    AND json_type(payload) = 'object'
    AND chat_id IN (SELECT id FROM chats)
)
WHERE copy = 1;

INSERT INTO chat_message_parts (message_id, idx, payload)
SELECT m.id, p.key, p.value
FROM chat_messages_v2 m
JOIN chat_messages o ON o.id = m.id,
     json_each(o.payload, '$.parts') p
WHERE json_type(o.payload, '$.parts') = 'array'
  AND p.type = 'object';

DROP TABLE chat_messages;
ALTER TABLE chat_messages_v2 RENAME TO chat_messages;

ALTER TABLE chats DROP COLUMN revision;
