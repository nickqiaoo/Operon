-- The account's other machines this machine trusts, each pinned to its
-- delegation public key. Requests between machines are encrypted with these
-- keys, never with keys Broker hands out, so Broker can relay them but not read
-- or forge them.
--
-- Kept apart from chat_mobile_pairings on purpose: a paired phone may call the
-- whole API, another machine only what nodeDelegationRoute allows. One table
-- would put the difference in a column every query has to remember.
--
-- A row is trusted either by a pairing code entered on one of the two machines
-- ('paired') or because a trusted machine vouched for it ('introduced'). A
-- revoked row is a tombstone: machines keep exchanging it so a revocation made
-- on one reaches the others, and an older trust record cannot bring it back.
-- `changed_at` orders those records; the later one wins.

CREATE TABLE IF NOT EXISTS machine_peers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id         TEXT NOT NULL,
  public_key      BLOB NOT NULL,
  fingerprint     TEXT NOT NULL,
  label           TEXT,
  status          TEXT NOT NULL CHECK (status IN ('trusted','revoked')),
  source          TEXT NOT NULL CHECK (source IN ('paired','introduced')),
  -- The machine that vouched for an introduced peer.
  introduced_by   TEXT,
  changed_at      INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  last_seen_at    INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_machine_peers_node ON machine_peers(node_id);
