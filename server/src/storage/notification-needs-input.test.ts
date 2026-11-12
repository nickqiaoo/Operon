import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { SqliteStorage } from './sqlite.js'

let directory: string
let storage: SqliteStorage

// The desktop addon uses Electron's ABI. Run this suite with
// ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run <file>.
let sqliteAvailable = true
try {
  new Database(':memory:').close()
} catch (error) {
  if (!(error instanceof Error) || !error.message.includes('NODE_MODULE_VERSION')) throw error
  sqliteAvailable = false
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'notification-needs-input-'))
  storage = new SqliteStorage(join(directory, 'test.db'))
})

afterEach(() => {
  storage.close()
  rmSync(directory, { recursive: true, force: true })
})

const needsInput = (chatId: number) => storage.notificationUpsert({
  kind: 'chat_needs_input', severity: 'action', sourceKey: `chat:${chatId}`, chatId, title: `Chat ${chatId}`,
})

const needsYou = () => storage.notificationList({ severity: 'action' }).map((n) => n.chatId)

describe.skipIf(!sqliteAvailable)('settling a chat that no longer needs input', () => {
  it('drops an answered row out of Needs you even when viewing the chat had already read it', () => {
    const row = needsInput(1)
    storage.notificationMarkRead([row.id])

    expect(storage.notificationSettleNeedsInput('chat:1', { markRead: true })).toEqual([row.id])

    expect(needsYou()).toEqual([])
    expect(storage.notificationGet(row.id)).toMatchObject({ severity: 'info', kind: 'chat_needs_input' })
    // Still in the history.
    expect(storage.notificationList({}).map((n) => n.id)).toEqual([row.id])
  })

  it('reads the row when the user answered, and leaves it unread when the turn just ended', () => {
    const answered = needsInput(1)
    const ended = needsInput(2)

    storage.notificationSettleNeedsInput('chat:1', { markRead: true })
    storage.notificationSettleNeedsInput('chat:2', { markRead: false })

    expect(storage.notificationGet(answered.id)?.readAt).not.toBeNull()
    expect(storage.notificationGet(ended.id)).toMatchObject({ severity: 'info', readAt: null })
  })

  it('touches only that chat, and a new request makes it ask again', () => {
    needsInput(1)
    needsInput(2)

    storage.notificationSettleNeedsInput('chat:1', { markRead: true })
    expect(needsYou()).toEqual([2])

    needsInput(1)
    expect(needsYou().sort()).toEqual([1, 2])
  })

  it('leaves a row chat_complete has already replaced', () => {
    const row = storage.notificationUpsert({
      kind: 'chat_complete', severity: 'info', sourceKey: 'chat:1', chatId: 1, title: 'Chat 1',
    })
    expect(storage.notificationSettleNeedsInput('chat:1', { markRead: true })).toEqual([])
    expect(storage.notificationGet(row.id)?.readAt).toBeNull()
  })

  it('settles every row at once after a restart, keeping read state', () => {
    needsInput(1)
    needsInput(2)

    expect(storage.notificationSettleNeedsInput(null, { markRead: false })).toHaveLength(2)
    expect(needsYou()).toEqual([])
    expect(storage.notificationUnreadCounts()).toMatchObject({ total: 2, action: 0 })
  })
})
