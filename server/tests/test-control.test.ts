import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { Hono } from 'hono'
import { SqliteStorage } from '../src/storage/sqlite.js'
import { testControlRoutes } from '../src/routes/test-control.js'
import { FakeRuntimeProvider } from '@operon/agent-runtime'

describe('/api/test routes', () => {
  let storage: SqliteStorage
  let dir: string
  let workspaceCwd: string
  let app: Hono
  let lastSeed: { projectId: number; workspaceId: number; workspaceCwd: string }

  beforeEach(() => {
    FakeRuntimeProvider.resetScripts()
    dir = mkdtempSync(path.join(tmpdir(), 'operon-test-control-'))
    workspaceCwd = mkdtempSync(path.join(tmpdir(), 'operon-test-control-cwd-'))
    storage = new SqliteStorage(path.join(dir, 'db.sqlite'))

    const seed = () => {
      const project = storage.createProject({ name: 'Seed', rootPath: workspaceCwd })
      const ws = storage.createWorkspace(project.id, {
        name: 'main',
        branchName: 'main',
        worktreePath: workspaceCwd,
      })
      lastSeed = { projectId: project.id, workspaceId: ws.id, workspaceCwd }
      return lastSeed
    }
    seed()

    app = new Hono()
    app.route('/api/test', testControlRoutes({ storage, reseed: seed }))
  })

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
      rmSync(workspaceCwd, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('GET /scripts lists registered scripts and current selection', async () => {
    const res = await app.request('/api/test/fake/scripts')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { scripts: string[]; current: string }
    expect(body.scripts.length).toBeGreaterThan(10)
    expect(body.scripts).toContain('claude-text-only')
    expect(body.current).toBe('default')
  })

  it('POST /script switches the active script', async () => {
    const res = await app.request('/api/test/fake/script', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'claude-tool-call' }),
    })
    expect(res.status).toBe(200)
    expect(FakeRuntimeProvider.currentScript).toBe('claude-tool-call')
  })

  it('POST /script rejects unknown names with 400', async () => {
    const res = await app.request('/api/test/fake/script', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'totally-not-real' }),
    })
    expect(res.status).toBe(400)
  })

  it('POST /reset reinstalls built-in scripts and selects default', async () => {
    FakeRuntimeProvider.scripts.set('foo', async function* () {})
    FakeRuntimeProvider.currentScript = 'foo'
    const res = await app.request('/api/test/fake/reset', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(FakeRuntimeProvider.currentScript).toBe('default')
    expect(FakeRuntimeProvider.scripts.has('claude-text-only')).toBe(true)
  })

  it('POST /db/reset truncates user data and re-seeds', async () => {
    // Pre-populate via direct SQL so we don't depend on storage method names.
    const db = storage.getDatabase()
    db.prepare(
      `INSERT INTO chats (workspace_id, title, provider_id, model, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(lastSeed.workspaceId, 'precious', 'fake', 'fake-1', Date.now())
    const before = db.prepare('SELECT COUNT(*) as c FROM chats').get() as { c: number }
    expect(before.c).toBeGreaterThan(0)

    const res = await app.request('/api/test/db/reset', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; workspaceId: number }
    expect(body.ok).toBe(true)
    expect(body.workspaceId).toBeGreaterThan(0)

    const after = db.prepare('SELECT COUNT(*) as c FROM chats').get() as { c: number }
    expect(after.c).toBe(0)
  })
})
