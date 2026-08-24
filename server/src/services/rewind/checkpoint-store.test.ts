import { beforeEach, describe, expect, it } from 'vitest'
import type { CheckpointRecord, CheckpointStorageAdapter } from '../../storage/interface.js'
import * as checkpointStore from './checkpoint-store.js'

class InMemoryCheckpointStorage implements CheckpointStorageAdapter {
  private data = new Map<number, Map<string, CheckpointRecord>>()

  saveCheckpoint(chatId: number, messageUid: string, entry: CheckpointRecord): void {
    let chat = this.data.get(chatId)
    if (!chat) {
      chat = new Map()
      this.data.set(chatId, chat)
    }
    chat.set(messageUid, entry)
  }

  setCheckpointEnd(chatId: number, messageUid: string, endSnapshotId: string): void {
    const entry = this.data.get(chatId)?.get(messageUid)
    if (entry) entry.endSnapshotId = endSnapshotId
  }

  getCheckpoint(chatId: number, messageUid: string): CheckpointRecord | undefined {
    return this.data.get(chatId)?.get(messageUid)
  }

  listCheckpoints(chatId: number): Record<string, CheckpointRecord> {
    const chat = this.data.get(chatId)
    if (!chat) return {}
    return Object.fromEntries(chat.entries())
  }

  removeCheckpoints(chatId: number): void {
    this.data.delete(chatId)
  }

  pruneCheckpoints(chatId: number, keep: number): string[] {
    const chat = this.data.get(chatId)
    if (!chat) return []
    const sorted = [...chat.entries()].sort((a, b) => b[1].createdAt - a[1].createdAt)
    const evicted = sorted.slice(keep).map(([uid]) => uid)
    for (const uid of evicted) {
      chat.delete(uid)
    }
    return evicted
  }
}

describe('checkpoint-store', () => {
  let storage: InMemoryCheckpointStorage

  beforeEach(() => {
    storage = new InMemoryCheckpointStorage()
    checkpointStore.init(storage)
  })

  it('save + get round trip returns the same entry', () => {
    const entry: CheckpointRecord = { snapshotId: 'snap-1', createdAt: 1000 }
    checkpointStore.save(1, 'msg-a', entry)
    expect(checkpointStore.get(1, 'msg-a')).toEqual(entry)
  })

  it('get returns undefined for unknown chat/message', () => {
    expect(checkpointStore.get(99, 'missing')).toBeUndefined()
  })

  it('list returns all entries for a chat keyed by messageUid', () => {
    checkpointStore.save(1, 'msg-a', { snapshotId: 'snap-a', createdAt: 1 })
    checkpointStore.save(1, 'msg-b', { snapshotId: 'snap-b', createdAt: 2 })
    checkpointStore.save(2, 'msg-c', { snapshotId: 'snap-c', createdAt: 3 })

    const list = checkpointStore.list(1)
    expect(Object.keys(list).sort()).toEqual(['msg-a', 'msg-b'])
    expect(list['msg-a'].snapshotId).toBe('snap-a')
    expect(list['msg-b'].snapshotId).toBe('snap-b')
  })

  it('remove clears only the target chat', () => {
    checkpointStore.save(1, 'msg-a', { snapshotId: 'snap-a', createdAt: 1 })
    checkpointStore.save(2, 'msg-b', { snapshotId: 'snap-b', createdAt: 2 })
    checkpointStore.remove(1)
    expect(checkpointStore.list(1)).toEqual({})
    expect(checkpointStore.get(2, 'msg-b')).toMatchObject({ snapshotId: 'snap-b' })
  })

  it('prune keeps only the most recent N checkpoints per chat', () => {
    for (let i = 1; i <= 13; i++) {
      checkpointStore.save(1, `msg-${i}`, { snapshotId: `snap-${i}`, createdAt: i })
    }
    const evicted = checkpointStore.prune(1, 10)

    // The three oldest are returned as evicted...
    expect(evicted.sort()).toEqual(['msg-1', 'msg-2', 'msg-3'].sort())
    const list = checkpointStore.list(1)
    expect(Object.keys(list)).toHaveLength(10)
    // ...dropped from storage; the newest survive.
    expect(list['msg-1']).toBeUndefined()
    expect(list['msg-3']).toBeUndefined()
    expect(list['msg-4']).toMatchObject({ snapshotId: 'snap-4' })
    expect(list['msg-13']).toMatchObject({ snapshotId: 'snap-13' })
  })

  it('setEnd attaches the closing snapshot without disturbing the start one', () => {
    checkpointStore.save(1, 'msg-a', { snapshotId: 'snap-a', createdAt: 1 })
    checkpointStore.setEnd(1, 'msg-a', 'snap-a-end')
    expect(checkpointStore.get(1, 'msg-a')).toEqual({
      snapshotId: 'snap-a',
      endSnapshotId: 'snap-a-end',
      createdAt: 1,
    })
  })

  it('re-saving a checkpoint drops a stale end snapshot', () => {
    checkpointStore.save(1, 'msg-a', { snapshotId: 'snap-a', createdAt: 1 })
    checkpointStore.setEnd(1, 'msg-a', 'snap-a-end')
    // A retry of the same turn restarts it, so the old closing snapshot no
    // longer describes the interval.
    checkpointStore.save(1, 'msg-a', { snapshotId: 'snap-a2', createdAt: 2 })
    expect(checkpointStore.get(1, 'msg-a')?.endSnapshotId).toBeUndefined()
  })

})
