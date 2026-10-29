import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { SqliteStorage } from './sqlite.js'
import { notificationRoutes } from '../routes/notifications.js'
import { onInboxEvent, type InboxEvent } from '../services/channel-bus.js'

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
  directory = mkdtempSync(join(tmpdir(), 'notification-destinations-'))
  storage = new SqliteStorage(join(directory, 'test.db'))
})

afterEach(() => {
  storage.close()
  rmSync(directory, { recursive: true, force: true })
})

function seed() {
  const message = storage.notificationUpsert({
    kind: 'assistant_message', severity: 'info', sourceKey: 'assistant:message', title: 'Assistant update',
  })
  const approval = storage.notificationUpsert({
    kind: 'assistant_approval', severity: 'action', sourceKey: 'assistant:approval:1', title: 'Approval needed',
  })
  const inbox = storage.notificationUpsert({
    kind: 'chat_needs_input', severity: 'action', sourceKey: 'chat:1', title: 'Chat needs you',
  })
  return { message, approval, inbox }
}

describe.skipIf(!sqliteAvailable)('notification destinations', () => {
  it('counts assistant messages and approvals separately and excludes read or archived rows', () => {
    const { message, approval } = seed()
    expect(storage.notificationUnreadCounts()).toEqual({
      total: 1, action: 1, assistantTotal: 2, assistantAction: 1,
    })
    storage.notificationMarkRead([message.id])
    storage.notificationArchive([approval.id])
    expect(storage.notificationUnreadCounts()).toEqual({
      total: 1, action: 1, assistantTotal: 0, assistantAction: 0,
    })
  })

  it('filters assistant rows before inbox pagination and severity filtering', async () => {
    const { inbox } = seed()
    const response = await notificationRoutes(storage).request('/?limit=1&severity=action')
    expect(await response.json()).toEqual({ notifications: [inbox], hasMore: false })
  })

  it('keeps assistant notifications unread when marking the inbox read, then clears them from the assistant', async () => {
    const { message, approval, inbox } = seed()
    const events: InboxEvent[] = []
    const unsubscribe = onInboxEvent((event) => events.push(event))
    try {
      const routes = notificationRoutes(storage)
      const read = (body: object) => routes.request('/read', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      expect(await (await read({ all: true })).json()).toEqual({ ids: [inbox.id] })
      expect(storage.notificationGet(message.id)?.readAt).toBeNull()
      expect(storage.notificationGet(approval.id)?.readAt).toBeNull()
      expect(events.at(-1)).toEqual({
        type: 'counts', total: 0, action: 0, assistantTotal: 2, assistantAction: 1,
      })

      await read({ sourcePrefix: 'assistant:' })
      expect(events.at(-1)).toEqual({
        type: 'counts', total: 0, action: 0, assistantTotal: 0, assistantAction: 0,
      })
    } finally {
      unsubscribe()
    }
  })
})
