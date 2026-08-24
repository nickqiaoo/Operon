#!/usr/bin/env node
// Stand-alone verification for migration 0017_unified_agent_bindings.sql.
// Builds a fresh SQLite DB, runs migrations 0001..0016, seeds realistic data,
// then runs 0017 and checks invariants.

import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = path.join(__dirname, '..', 'src', 'storage', 'migrations')
const DB_PATH = path.join('/tmp', `xui-mig-verify-${Date.now()}.db`)

function applyMigration(db, file) {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
  db.exec(sql)
}

function listMigrations() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort()
}

function row(stmt, ...params) {
  return stmt.get(...params)
}

function rows(stmt, ...params) {
  return stmt.all(...params)
}

function pass(label) {
  console.log(`  ✓ ${label}`)
}
function fail(label, detail) {
  console.error(`  ✗ ${label}`)
  if (detail) console.error(`    ${detail}`)
  process.exitCode = 1
}

function asJson(value) {
  return JSON.stringify(value)
}

async function main() {
  console.log(`\n[verify-0017] DB: ${DB_PATH}\n`)

  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH)
  const db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')

  // Bootstrap schema_migrations table the way runMigrations does.
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `)

  const all = listMigrations()
  const before017 = all.filter((f) => f < '0017')
  const target = all.find((f) => f.startsWith('0017_'))
  if (!target) {
    fail('migration 0017 file not found')
    return
  }

  console.log('[verify-0017] applying pre-0017 migrations:')
  for (const f of before017) {
    applyMigration(db, f)
    console.log(`  applied ${f}`)
  }

  // ---------- seed legacy data ----------
  console.log('\n[verify-0017] seeding legacy data...')

  // projects + workspaces
  db.prepare(
    `INSERT INTO projects (id, name, root_path, created_at, updated_at)
     VALUES (1, 'proj-a', '/tmp/repo-a', 0, 0), (2, 'proj-b', '/tmp/repo-b', 0, 0)`,
  ).run()
  db.prepare(
    `INSERT INTO workspaces (id, project_id, name, branch_name, worktree_path, created_at, updated_at)
     VALUES (101, 1, 'ws-a-1', 'main', '/tmp/repo-a', 0, 0),
            (102, 2, 'ws-b-1', 'main', '/tmp/repo-b', 0, 0),
            (103, 1, 'ws-a-2', 'feature', '/tmp/repo-a-feature', 0, 0)`,
  ).run()

  // agents
  db.prepare(
    `INSERT INTO agents (id, name, provider, model) VALUES
     (1, 'alice',   'claude-code', 'sonnet'),
     (2, 'bob',     'codex',       'gpt-5'),
     (3, 'charlie', 'gemini-cli',  'gemini-pro')`,
  ).run()

  // channels (proj-a has 2 channels, proj-b has 1)
  db.prepare(
    `INSERT INTO channels (id, project_id, name) VALUES
     (10, 1, 'frontend'),
     (11, 1, 'backend'),
     (12, 2, 'general')`,
  ).run()

  // channel_members: alice in all 3; bob in 10 & 11; charlie only in 12
  db.prepare(
    `INSERT INTO channel_members (channel_id, agent_id) VALUES
     (10, 1), (11, 1), (12, 1),
     (10, 2), (11, 2),
     (12, 3)`,
  ).run()

  // agent_sessions (legacy): per (agent, project)
  // alice in proj-a (active, with chat 5001), alice in proj-b (idle, no chat),
  // bob in proj-a (offline), charlie in proj-b (idle)
  db.prepare(
    `INSERT INTO agent_sessions (agent_id, project_id, workspace_id, chat_id, status, updated_at) VALUES
     (1, 1, 101, 5001, 'active',  1700000000000),
     (1, 2, 102, NULL, 'idle',    1700000000001),
     (2, 1, 103, NULL, 'offline', 1700000000002),
     (3, 2, 102, 5003, 'idle',    1700000000003)`,
  ).run()

  // im_providers (mate slack)
  db.prepare(
    `INSERT INTO im_providers (id, source, instance_id, mode, agent_id, self_user_id, self_bot_id, display_name, credentials_json)
     VALUES (200, 'slack', 'inst-slack-1', 'mate', 2, 'U_BOB',     'B_BOB',     'bob-slack',    '{}'),
            (201, 'slack', 'inst-slack-2', 'mate', 3, 'U_CHARLIE', 'B_CHARLIE', 'charlie-slack','{}')`,
  ).run()

  // im_channel_bindings: bob bound to slack:C-X with workspace 101, charlie bound to slack:C-Y with no workspace yet
  db.prepare(
    `INSERT INTO im_channel_bindings (id, source, source_channel, source_channel_name, channel_kind,
                                       agent_id, provider_id, workspace_id, active_chat_id, created_at)
     VALUES (300, 'slack', 'C-X', '#general',    'channel', 2, 200, 101,  6001, 1700000000010),
            (301, 'slack', 'C-Y', NULL,          'channel', 3, 201, NULL, NULL, 1700000000011)`,
  ).run()

  // legacy cursors
  db.prepare(
    `INSERT INTO agent_read_cursors (agent_id, channel_id, last_read_seq) VALUES
     (1, 10, 42),
     (1, 11, 17),
     (2, 10,  9)`,
  ).run()
  db.prepare(
    `INSERT INTO agent_im_cursors (agent_id, source, source_channel, last_read_id) VALUES
     (2, 'slack', 'C-X', 100),
     (3, 'slack', 'C-Y',   0)`,
  ).run()

  console.log('  seed complete')

  // ---------- before snapshot ----------
  const beforeSessions = row(db.prepare('SELECT COUNT(*) AS n FROM agent_sessions')).n
  const beforeIMBindings = row(db.prepare('SELECT COUNT(*) AS n FROM im_channel_bindings')).n
  const beforeChannelCursors = row(db.prepare('SELECT COUNT(*) AS n FROM agent_read_cursors')).n
  const beforeMateCursors = row(db.prepare('SELECT COUNT(*) AS n FROM agent_im_cursors')).n
  console.log(
    `\n[verify-0017] pre-migration counts: sessions=${beforeSessions}, im_bindings=${beforeIMBindings}, ` +
      `app_cursors=${beforeChannelCursors}, mate_cursors=${beforeMateCursors}`,
  )

  // ---------- apply 0017 ----------
  console.log(`\n[verify-0017] applying ${target}...`)
  applyMigration(db, target)
  console.log(`  applied ${target}`)

  // ---------- assertions ----------
  console.log('\n[verify-0017] checks:')

  // Old tables gone
  for (const t of ['agent_sessions', 'im_channel_bindings', 'agent_read_cursors', 'agent_im_cursors']) {
    const exists = row(
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`),
      t,
    )
    if (exists) fail(`legacy table ${t} should be dropped`)
    else pass(`legacy table ${t} dropped`)
  }

  // New tables exist
  for (const t of ['agent_bindings', 'agent_message_cursors', 'agent_inbox_messages']) {
    const exists = row(
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`),
      t,
    )
    if (!exists) fail(`new table ${t} missing`)
    else pass(`new table ${t} created`)
  }

  // App bindings: agent_sessions JOIN channel_members
  // Expected expansion:
  //   alice@proj-a (sessions row) + alice in {10,11} → 2 app rows (workspace 101, status 'active', chat NULL)
  //   alice@proj-b + alice in {12}                   → 1 app row  (ws 102, status 'idle')
  //   bob@proj-a   + bob   in {10,11}                → 2 app rows (ws 103, status 'offline')
  //   charlie@proj-b + charlie in {12}               → 1 app row  (ws 102, status 'idle')
  // Total: 6 app bindings
  const appBindings = rows(
    db.prepare(
      `SELECT agent_id, scope_key, scope_display_name, project_id, workspace_id,
              active_chat_id, status, channel_kind
       FROM agent_bindings WHERE scope_kind = 'app' ORDER BY agent_id, scope_key`,
    ),
  )
  if (appBindings.length !== 6) {
    fail(
      `app bindings count = ${appBindings.length}, expected 6`,
      `rows: ${asJson(appBindings)}`,
    )
  } else {
    pass(`app bindings count = 6 (matches agent_sessions × channel_members)`)
  }

  // active_chat_id should always be NULL (Q1 = A: orphan legacy chat)
  const appWithChat = appBindings.filter((r) => r.active_chat_id !== null)
  if (appWithChat.length > 0) {
    fail(
      `app bindings with non-NULL active_chat_id: ${appWithChat.length}`,
      `expected all NULL (legacy chat is orphaned). rows: ${asJson(appWithChat)}`,
    )
  } else {
    pass('all app bindings have active_chat_id = NULL (legacy chat orphaned)')
  }

  // Status preserved from legacy session
  const aliceFrontend = appBindings.find((r) => r.agent_id === 1 && r.scope_key === '10')
  if (aliceFrontend?.status !== 'active') {
    fail(`alice@#frontend status = ${aliceFrontend?.status}, expected 'active'`)
  } else {
    pass(`alice@#frontend status preserved as 'active'`)
  }
  const bobBackend = appBindings.find((r) => r.agent_id === 2 && r.scope_key === '11')
  if (bobBackend?.status !== 'offline') {
    fail(`bob@#backend status = ${bobBackend?.status}, expected 'offline'`)
  } else {
    pass(`bob@#backend status preserved as 'offline'`)
  }

  // Display name: '#' + channel.name
  if (aliceFrontend?.scope_display_name !== '#frontend') {
    fail(
      `alice@#frontend scope_display_name = ${aliceFrontend?.scope_display_name}, expected '#frontend'`,
    )
  } else {
    pass(`scope_display_name = '#<channel name>'`)
  }

  // Workspace shared across same (agent, project)
  const aliceProjA = appBindings.filter((r) => r.agent_id === 1 && r.project_id === 1)
  const aliceWorkspaces = new Set(aliceProjA.map((r) => r.workspace_id))
  if (aliceWorkspaces.size !== 1 || !aliceWorkspaces.has(101)) {
    fail(
      `alice's bindings in proj-a should share workspace 101`,
      `got ${asJson([...aliceWorkspaces])}`,
    )
  } else {
    pass(`workspace shared across (agent, project) — alice@proj-a uses ws 101`)
  }

  // Mate bindings: 2 rows
  const mateBindings = rows(
    db.prepare(
      `SELECT id, agent_id, scope_kind, scope_key, scope_display_name, channel_kind,
              project_id, workspace_id, active_chat_id, status,
              im_provider_instance_id, agent_session_id, team_label, metadata
       FROM agent_bindings WHERE scope_kind IN ('slack', 'telegram') ORDER BY agent_id, scope_key`,
    ),
  )
  if (mateBindings.length !== 2) {
    fail(`mate bindings count = ${mateBindings.length}, expected 2`)
  } else {
    pass(`mate bindings count = 2`)
  }

  // Bob's mate binding: project_id derived from workspace 101 → 1
  const bobMate = mateBindings.find((r) => r.agent_id === 2)
  if (bobMate?.project_id !== 1) {
    fail(`bob mate binding project_id = ${bobMate?.project_id}, expected 1 (derived from workspace 101)`)
  } else {
    pass(`mate project_id correctly derived from workspaces.project_id`)
  }
  if (bobMate?.im_provider_instance_id !== 200) {
    fail(`bob mate binding im_provider_instance_id = ${bobMate?.im_provider_instance_id}, expected 200`)
  } else {
    pass(`im_provider_instance_id mapped from old provider_id`)
  }
  if (bobMate?.active_chat_id !== 6001) {
    fail(`bob mate binding active_chat_id = ${bobMate?.active_chat_id}, expected 6001 (preserved)`)
  } else {
    pass(`mate active_chat_id preserved (binding-scoped, unlike app)`)
  }

  // Charlie's pre-wizard binding: workspace_id NULL → project_id NULL
  const charlieMate = mateBindings.find((r) => r.agent_id === 3)
  if (charlieMate?.project_id !== null) {
    fail(
      `charlie pre-wizard mate binding project_id = ${charlieMate?.project_id}, expected NULL`,
      `pre-wizard binding has no workspace, so no project either`,
    )
  } else {
    pass(`pre-wizard mate binding has project_id = NULL (expected; wizard will fill)`)
  }

  // status all 'offline' for mate (was in-memory in old impl)
  const mateNonOffline = mateBindings.filter((r) => r.status !== 'offline')
  if (mateNonOffline.length > 0) {
    fail(`mate bindings should all start 'offline', got ${asJson(mateNonOffline)}`)
  } else {
    pass(`all mate bindings status = 'offline'`)
  }

  // metadata is NULL (after the check #1 fix removing source_channel_name from JSON)
  const mateWithMeta = mateBindings.filter((r) => r.metadata !== null)
  if (mateWithMeta.length > 0) {
    fail(
      `mate bindings should have metadata=NULL, got ${asJson(mateWithMeta.map((r) => r.metadata))}`,
    )
  } else {
    pass(`mate metadata = NULL (no redundant fields)`)
  }

  // Cursors: app + mate counts
  const appCursorRows = rows(
    db.prepare(
      `SELECT agent_id, stream_key, last_read_id FROM agent_message_cursors WHERE stream_kind = 'app'`,
    ),
  )
  if (appCursorRows.length !== beforeChannelCursors) {
    fail(
      `app cursors count = ${appCursorRows.length}, expected ${beforeChannelCursors}`,
      `rows: ${asJson(appCursorRows)}`,
    )
  } else {
    pass(`app cursors count matches agent_read_cursors (${beforeChannelCursors})`)
  }

  const mateCursorRows = rows(
    db.prepare(
      `SELECT agent_id, stream_key, last_read_id FROM agent_message_cursors WHERE stream_kind = 'mate'`,
    ),
  )
  if (mateCursorRows.length !== beforeMateCursors) {
    fail(
      `mate cursors count = ${mateCursorRows.length}, expected ${beforeMateCursors}`,
      `rows: ${asJson(mateCursorRows)}`,
    )
  } else {
    pass(`mate cursors count matches agent_im_cursors (${beforeMateCursors})`)
  }

  // Spot-check cursor key formats
  const aliceFrontendCursor = appCursorRows.find((r) => r.agent_id === 1 && r.stream_key === '10')
  if (aliceFrontendCursor?.last_read_id !== 42) {
    fail(`alice/#frontend cursor last_read_id = ${aliceFrontendCursor?.last_read_id}, expected 42`)
  } else {
    pass(`app cursor key = String(channel_id) and last_read_id preserved`)
  }
  const bobMateCursor = mateCursorRows.find((r) => r.agent_id === 2 && r.stream_key === 'slack:C-X')
  if (bobMateCursor?.last_read_id !== 100) {
    fail(`bob mate cursor last_read_id = ${bobMateCursor?.last_read_id}, expected 100`)
  } else {
    pass(`mate cursor key = '<source>:<source_channel>' and last_read_id preserved`)
  }

  // Inbox cursor stream_kind allowed but no rows
  const inboxCursors = row(
    db.prepare(`SELECT COUNT(*) AS n FROM agent_message_cursors WHERE stream_kind = 'inbox'`),
  ).n
  if (inboxCursors !== 0) {
    fail(`inbox cursors should start at 0, got ${inboxCursors}`)
  } else {
    pass(`no inbox cursors yet (expected; populated as agents check_inbox)`)
  }

  // Inbox messages table empty
  const inboxRows = row(db.prepare(`SELECT COUNT(*) AS n FROM agent_inbox_messages`)).n
  if (inboxRows !== 0) {
    fail(`agent_inbox_messages should be empty, got ${inboxRows}`)
  } else {
    pass(`agent_inbox_messages table empty`)
  }

  // UNIQUE(scope_kind, scope_key, agent_id) enforced — try inserting dup
  let uniqueEnforced = false
  try {
    db.prepare(
      `INSERT INTO agent_bindings (agent_id, scope_kind, scope_key, project_id, workspace_id, status,
                                    created_at, updated_at)
       VALUES (1, 'app', '10', 1, 101, 'idle', 0, 0)`,
    ).run()
  } catch (err) {
    uniqueEnforced = String(err.message).includes('UNIQUE')
  }
  if (!uniqueEnforced) {
    fail(`UNIQUE(scope_kind, scope_key, agent_id) not enforced`)
  } else {
    pass(`UNIQUE(scope_kind, scope_key, agent_id) enforced`)
  }

  // status CHECK constraint
  let statusCheckEnforced = false
  try {
    db.prepare(
      `INSERT INTO agent_bindings (agent_id, scope_kind, scope_key, status, created_at, updated_at)
       VALUES (1, 'app', 'badstatus', 'totally-not-a-status', 0, 0)`,
    ).run()
  } catch (err) {
    statusCheckEnforced = String(err.message).includes('CHECK')
  }
  if (!statusCheckEnforced) {
    fail(`status CHECK constraint not enforced`)
  } else {
    pass(`status CHECK constraint enforced`)
  }

  // Indexes present
  const indexes = rows(
    db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='agent_bindings'`),
  ).map((r) => r.name)
  const expectedIdx = [
    'idx_agent_bindings_agent_status',
    'idx_agent_bindings_project_kind_status',
    'idx_agent_bindings_active_chat',
    'idx_agent_bindings_im_provider',
    'idx_agent_bindings_agent_session',
    'idx_agent_bindings_team',
  ]
  const missing = expectedIdx.filter((i) => !indexes.includes(i))
  if (missing.length > 0) {
    fail(`missing indexes: ${missing.join(', ')}`)
  } else {
    pass(`all 6 expected indexes present on agent_bindings`)
  }

  // Final summary
  console.log('\n[verify-0017] done\n')

  if (process.exitCode === 1) {
    console.error('VERIFICATION FAILED — see ✗ above')
  } else {
    console.log('VERIFICATION PASSED ✓')
  }
}

main().catch((err) => {
  console.error('script error:', err)
  process.exit(2)
})
