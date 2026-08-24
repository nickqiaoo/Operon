import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CheckpointRecord, CheckpointStorageAdapter } from '../../storage/interface.js'

vi.mock('../rewind/rewind-service.js', () => ({
  capture: vi.fn(),
  protectSnapshot: vi.fn(),
  releaseSnapshots: vi.fn(),
  changedFiles: vi.fn(async () => []),
  changedFilesBetween: vi.fn(async () => []),
  turnFileDiffs: vi.fn(async () => []),
  turnFileDiffsBetween: vi.fn(async () => []),
}))

const RewindService = await import('../rewind/rewind-service.js')
const { CheckpointStore } = await import('../rewind/index.js')
const { getTurnDiffs, getTurnFileDiffs } = await import('./rewind.js')

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
    return Object.fromEntries(this.data.get(chatId)?.entries() ?? [])
  }

  removeCheckpoints(chatId: number): void {
    this.data.delete(chatId)
  }

  pruneCheckpoints(): string[] {
    return []
  }
}

const NOW = 1_700_000_000_000
const MINUTE = 60 * 1000
const CWD = '/tmp/workspace'
const CHAT = 1

const oneFile = [{ path: 'a.ts', status: 'M', additions: 1, deletions: 0 }]

describe('per-turn diff intervals', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    vi.mocked(RewindService.changedFiles).mockResolvedValue(oneFile)
    vi.mocked(RewindService.changedFilesBetween).mockResolvedValue(oneFile)
    vi.mocked(RewindService.turnFileDiffs).mockResolvedValue([])
    vi.mocked(RewindService.turnFileDiffsBetween).mockResolvedValue([])
    CheckpointStore.init(new InMemoryCheckpointStorage())
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('closes a turn with its own end snapshot, never the worktree', async () => {
    CheckpointStore.save(CHAT, 'msg-1', { snapshotId: 'start-1', createdAt: NOW - 10 * MINUTE })
    CheckpointStore.setEnd(CHAT, 'msg-1', 'end-1')

    const { turns } = await getTurnDiffs(CHAT, CWD)

    expect(turns).toHaveLength(1)
    expect(RewindService.changedFilesBetween).toHaveBeenCalledWith(CWD, 'start-1', 'end-1')
    expect(RewindService.changedFiles).not.toHaveBeenCalled()
  })

  it('excludes edits made between turns from the earlier turn', async () => {
    CheckpointStore.save(CHAT, 'msg-1', { snapshotId: 'start-1', createdAt: NOW - 20 * MINUTE })
    CheckpointStore.setEnd(CHAT, 'msg-1', 'end-1')
    // 'start-2' !== 'end-1' — the user edited files while the chat sat idle.
    CheckpointStore.save(CHAT, 'msg-2', { snapshotId: 'start-2', createdAt: NOW - 10 * MINUTE })
    CheckpointStore.setEnd(CHAT, 'msg-2', 'end-2')

    await getTurnDiffs(CHAT, CWD)

    expect(RewindService.changedFilesBetween).toHaveBeenCalledWith(CWD, 'start-1', 'end-1')
    expect(RewindService.changedFilesBetween).not.toHaveBeenCalledWith(CWD, 'start-1', 'start-2')
  })

  it('drops a stale unbounded turn instead of blaming it for later drift', async () => {
    // Written before end snapshots existed (or the process died mid-turn).
    CheckpointStore.save(CHAT, 'msg-1', { snapshotId: 'start-1', createdAt: NOW - 6 * MINUTE })

    const { turns } = await getTurnDiffs(CHAT, CWD)

    expect(turns).toEqual([])
    expect(RewindService.changedFiles).not.toHaveBeenCalled()
  })

  it('still uses the worktree for an unbounded turn that just ran', async () => {
    CheckpointStore.save(CHAT, 'msg-1', { snapshotId: 'start-1', createdAt: NOW - MINUTE })

    const { turns } = await getTurnDiffs(CHAT, CWD)

    expect(turns).toHaveLength(1)
    expect(RewindService.changedFiles).toHaveBeenCalledWith(CWD, 'start-1')
  })

  it('bounds a legacy non-final turn by the next turn start', async () => {
    CheckpointStore.save(CHAT, 'msg-1', { snapshotId: 'start-1', createdAt: NOW - 20 * MINUTE })
    CheckpointStore.save(CHAT, 'msg-2', { snapshotId: 'start-2', createdAt: NOW - 10 * MINUTE })
    CheckpointStore.setEnd(CHAT, 'msg-2', 'end-2')

    await getTurnDiffs(CHAT, CWD)

    expect(RewindService.changedFilesBetween).toHaveBeenCalledWith(CWD, 'start-1', 'start-2')
  })

  it('getTurnFileDiffs applies the same bound as the diff cards', async () => {
    CheckpointStore.save(CHAT, 'msg-1', { snapshotId: 'start-1', createdAt: NOW - 30 * MINUTE })
    CheckpointStore.setEnd(CHAT, 'msg-1', 'end-1')

    const result = await getTurnFileDiffs(CHAT, CWD, 'msg-1')

    expect(result.snapshotId).toBe('start-1')
    expect(RewindService.turnFileDiffsBetween).toHaveBeenCalledWith(CWD, 'start-1', 'end-1')
    expect(RewindService.turnFileDiffs).not.toHaveBeenCalled()
  })

  it('getTurnFileDiffs returns nothing for a stale unbounded turn', async () => {
    CheckpointStore.save(CHAT, 'msg-1', { snapshotId: 'start-1', createdAt: NOW - 30 * MINUTE })

    const result = await getTurnFileDiffs(CHAT, CWD)

    expect(result.files).toEqual([])
    expect(RewindService.turnFileDiffs).not.toHaveBeenCalled()
  })
})
