import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import { afterAll, describe, expect, it } from 'vitest'
import { SqliteStorage } from './sqlite.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operon-workspace-origin-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

// better-sqlite3 is built for Electron's Node; under a plain Node it does not load. Run with
// `ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run <this file>` to cover it.
let opened: SqliteStorage | undefined
try {
  opened = new SqliteStorage(path.join(dir, 'test.db'))
} catch {
  opened = undefined
}
const storage = opened as SqliteStorage

const BACKFILL = fs.readFileSync(
  path.join(path.dirname(new URL(import.meta.url).pathname), 'migrations', '0026_workspace_origin_chat.sql'),
  'utf8',
).split('\n').filter((line) => !line.startsWith('ALTER TABLE')).join('\n')

describe.skipIf(!opened)('workspace origin chat', () => {
  it('records which conversation made a workspace', () => {
    const project = storage.createProject({ name: 'p', rootPath: '/p' })
    const own = storage.createWorkspace(project.id, { name: 'main', branchName: 'main', worktreePath: '/p' })
    const made = storage.createWorkspace(project.id, { name: 'login', branchName: 'login', worktreePath: '/wt/login', originChatId: 7 })
    expect(storage.getWorkspace(own.id)?.originChatId).toBeNull()
    expect(storage.getWorkspace(made.id)?.originChatId).toBe(7)
    expect(storage.listWorkspaces(project.id).map((w) => w.originChatId)).toEqual([null, 7])
  })

  it('backfills workspaces that only hold agents dispatched from elsewhere', () => {
    const db = new Database(path.join(dir, 'test.db'))
    const project = storage.createProject({ name: 'q', rootPath: '/q' })
    const main = storage.createWorkspace(project.id, { name: 'main', branchName: 'main', worktreePath: '/q' })
    const agentOnly = storage.createWorkspace(project.id, { name: 'api', branchName: 'api', worktreePath: '/wt/api' })
    const userToo = storage.createWorkspace(project.id, { name: 'ui', branchName: 'ui', worktreePath: '/wt/ui' })
    const lead = storage.createChat({ tp: 'chat', title: 'lead', workspaceId: main.id, updatedAt: Date.now() })
    const agent = (workspaceId: number) => storage.createChat({
      tp: 'subagent', title: 'agent', workspaceId, updatedAt: Date.now(),
      metadata: { externalAgent: { agentId: `a${workspaceId}`, parentChatId: lead, description: 'x', model: 'default' } },
    })
    agent(agentOnly.id)
    agent(userToo.id)
    storage.createChat({ tp: 'chat', title: 'mine', workspaceId: userToo.id, updatedAt: Date.now() })
    // An agent sent into the lead's own workspace does not make that one dispatched.
    agent(main.id)

    db.exec(BACKFILL)
    db.close()
    expect(storage.getWorkspace(agentOnly.id)?.originChatId).toBe(lead)
    expect(storage.getWorkspace(userToo.id)?.originChatId).toBeNull()
    expect(storage.getWorkspace(main.id)?.originChatId).toBeNull()
  })
})
