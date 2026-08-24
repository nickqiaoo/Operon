import { Hono } from 'hono'
import type { SqliteStorage } from '../storage/sqlite.js'
import { FakeRuntimeProvider } from '@operon/agent-runtime'
import { BUILTIN_SCRIPT_NAMES } from '@operon/agent-runtime'
import { getSessionManager } from '../services/ai/state.js'

/**
 * Test-control routes mounted only when `OPERON_ENABLE_FAKE_RUNTIME=1`.
 *
 * Provides hooks that e2e tests use in `beforeEach`:
 *   - GET  /scripts                  list registered fake script names
 *   - POST /script        body { name } switch the active fake script
 *   - POST /reset                    re-install built-in scripts and select default
 *   - POST /db/reset                 truncate user-data tables and re-seed
 */
export interface TestControlDeps {
  storage: SqliteStorage
  /** Re-seed the storage to a known empty state. Returns the seed workspace id. */
  reseed: () => { projectId: number; workspaceId: number; workspaceCwd: string }
}

export function testControlRoutes(deps: TestControlDeps) {
  const app = new Hono()

  app.get('/fake/scripts', (c) => {
    return c.json({ scripts: BUILTIN_SCRIPT_NAMES, current: FakeRuntimeProvider.currentScript })
  })

  app.post('/fake/script', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { name?: string }
    if (typeof body.name !== 'string' || !FakeRuntimeProvider.scripts.has(body.name)) {
      return c.json(
        {
          error: 'unknown_script',
          available: Array.from(FakeRuntimeProvider.scripts.keys()),
        },
        400,
      )
    }
    FakeRuntimeProvider.currentScript = body.name
    return c.json({ ok: true, current: body.name })
  })

  app.post('/fake/reset', (c) => {
    FakeRuntimeProvider.resetScripts()
    return c.json({ ok: true, current: FakeRuntimeProvider.currentScript })
  })

  app.post('/db/reset', async (c) => {
    // Tear down any in-flight runtime sessions before truncating their backing
    // storage rows. If we don't, a stale session left over from a previous
    // test may keep streaming and write into a deleted-then-recreated chat id.
    await getSessionManager().destroyAll()
    truncateUserData(deps.storage)
    const seed = deps.reseed()
    FakeRuntimeProvider.resetScripts()
    return c.json({ ok: true, ...seed })
  })

  return app
}

/**
 * Truncate every user-mutable table. Keeps schema and the `migrations` table
 * intact. This is intentionally aggressive — tests should be able to assume a
 * clean slate after calling /api/test/db/reset.
 */
function truncateUserData(storage: SqliteStorage): void {
  const db = storage.getDatabase()
  const rows = db
    .prepare(
      `SELECT name, sql FROM sqlite_master
       WHERE type='table'
         AND name NOT LIKE 'sqlite_%'
         AND name != 'migrations'`,
    )
    .all() as Array<{ name: string; sql: string | null }>

  // FTS5 virtual tables expose content/data/idx side-tables that cannot be
  // modified directly. Skip those — clearing the parent virtual table cascades
  // to its shadow tables automatically.
  const isFtsShadow = (name: string) =>
    /(_data|_idx|_content|_docsize|_config)$/.test(name)
  const ftsRoots = rows
    .filter((r) => r.sql?.toUpperCase().includes('USING FTS'))
    .map((r) => r.name)
  const targets = rows.filter((r) => {
    if (isFtsShadow(r.name)) return false
    return true
  })

  db.exec('PRAGMA foreign_keys = OFF')
  const txn = db.transaction(() => {
    for (const { name } of targets) {
      try {
        db.exec(`DELETE FROM "${name}"`)
      } catch (err) {
        // Some virtual tables (e.g. fts5) reject plain DELETE if no rows match
        // the supported delete protocol. Fall back to a parameterless reset.
        if (ftsRoots.includes(name)) {
          db.exec(`INSERT INTO "${name}"("${name}") VALUES('delete-all')`)
        } else {
          throw err
        }
      }
    }
  })
  txn()
  db.exec('PRAGMA foreign_keys = ON')
}
