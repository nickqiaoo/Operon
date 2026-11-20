import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { SqliteStorage } from './sqlite.js'
import { NOTIFICATION_RETENTION_MS, startNotificationPruning } from '../services/notification-service.js'

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

const DAY = 24 * 60 * 60_000
const START = new Date('2026-11-01T00:00:00Z').getTime()

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(START)
  directory = mkdtempSync(join(tmpdir(), 'notification-prune-'))
  storage = new SqliteStorage(join(directory, 'test.db'))
})

afterEach(() => {
  storage.close()
  rmSync(directory, { recursive: true, force: true })
  vi.useRealTimers()
})

const notify = (key: string) => storage.notificationUpsert({
  kind: 'task_done', severity: 'info', sourceKey: key, taskId: 1, title: key,
})

const remaining = () => storage.notificationList({}).map((n) => n.sourceKey).sort()

describe.skipIf(!sqliteAvailable)('pruning old notifications', () => {
  it('deletes rows read or dismissed before the cutoff, and keeps every unread row', () => {
    const read = notify('task:read')
    const archived = notify('task:archived')
    notify('task:unread')
    storage.notificationMarkRead([read.id])
    storage.notificationArchive([archived.id])

    vi.setSystemTime(START + 2 * DAY)
    const readLater = notify('task:read-later')
    storage.notificationMarkRead([readLater.id])

    // Cut off between the two reads: only the older read and the dismissal go.
    expect(storage.notificationPrune(START + DAY)).toBe(2)
    // notificationList hides archived rows, so check the dismissal by id.
    expect(storage.notificationGet(archived.id)).toBeNull()
    expect(remaining()).toEqual(['task:read-later', 'task:unread'])

    // However old, an unread row stays.
    expect(storage.notificationPrune(START + 365 * DAY)).toBe(1)
    expect(remaining()).toEqual(['task:unread'])
  })

  it('sweeps at startup and then daily, keeping a week of read rows', () => {
    const old = notify('task:old')
    storage.notificationMarkRead([old.id])
    // A millisecond past six days: the daily tick then lands just past the week.
    vi.setSystemTime(START + NOTIFICATION_RETENTION_MS - DAY + 1)
    const recent = notify('task:recent')
    storage.notificationMarkRead([recent.id])

    // Six days after the first read: nothing is old enough yet.
    const stop = startNotificationPruning(storage)
    expect(remaining()).toEqual(['task:old', 'task:recent'])

    // A day on, the first read crosses the week and the daily sweep takes it.
    vi.advanceTimersByTime(DAY)
    expect(remaining()).toEqual(['task:recent'])

    stop()
  })
})
