import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { SqliteStorage } from './sqlite.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operon-chat-tree-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

// better-sqlite3 is built for Electron's Node; run with
// `ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run <this file>`.
let opened: SqliteStorage | undefined
try {
  opened = new SqliteStorage(path.join(dir, 'test.db'))
} catch {
  opened = undefined
}
const storage = opened as SqliteStorage

describe.skipIf(!opened)('workspace tree rows', () => {
  it('lists agents started from another machine as rows, and keeps local agents under their parent', () => {
    const project = storage.createProject({ name: 'p', rootPath: '/p' })
    const workspaceId = storage.createWorkspace(project.id, { name: 'main', branchName: 'main', worktreePath: '/p' }).id
    const chat = storage.createChat({ tp: 'chat', title: 'Lead', workspaceId, updatedAt: 1 })
    const local = storage.createChat({ tp: 'subagent', title: 'Agent: local', workspaceId, updatedAt: 2 })
    storage.updateChatMetadata(local, { externalAgent: { agentId: `ext-${local}`, parentChatId: chat, description: 'local', model: 'default' } })
    const remote = storage.createChat({ tp: 'subagent', title: 'Agent: remote', workspaceId, updatedAt: 3 })
    storage.updateChatMetadata(remote, { externalAgent: {
      agentId: `ext-${remote}`, parentChatId: 0, description: 'remote', model: 'default',
      remoteParent: { nodeId: 'a'.repeat(32), chatId: 5 },
    } })

    const rows = (withRemoteAgents: boolean) =>
      storage.listChatEntries({ workspaceId, tp: 'chat', withRemoteAgents }).map((row) => row.id)
    expect(rows(true)).toEqual([remote, chat])
    expect(rows(false)).toEqual([chat])
  })
})
