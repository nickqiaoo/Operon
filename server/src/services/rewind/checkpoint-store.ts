import type { CheckpointRecord, CheckpointStorageAdapter } from '../../storage/interface.js'

// ---- Types ----

export interface CheckpointEntry extends CheckpointRecord {}

// ---- Singleton storage reference ----

let storageRef: CheckpointStorageAdapter | null = null

export function init(storage: CheckpointStorageAdapter): void {
  storageRef = storage
}

function getStorage(): CheckpointStorageAdapter {
  if (!storageRef) throw new Error('CheckpointStore not initialized — call init(storage) first')
  return storageRef
}

// ---- Public API ----

export function save(chatId: number, messageUid: string, entry: CheckpointEntry): void {
  getStorage().saveCheckpoint(chatId, messageUid, entry)
}

/**
 * Record the turn's closing snapshot without touching its start snapshot.
 * `overlapped` marks that another chat wrote to the workspace meanwhile, so the
 * interval cannot be trusted to describe this chat's changes alone.
 */
export function setEnd(
  chatId: number,
  messageUid: string,
  endSnapshotId: string,
  overlapped?: boolean,
): void {
  getStorage().setCheckpointEnd(chatId, messageUid, endSnapshotId, overlapped)
}

export function get(chatId: number, messageUid: string): CheckpointEntry | undefined {
  return getStorage().getCheckpoint(chatId, messageUid)
}

export function list(chatId: number): Record<string, CheckpointEntry> {
  return getStorage().listCheckpoints(chatId)
}

export function remove(chatId: number): void {
  getStorage().removeCheckpoints(chatId)
}

export function prune(chatId: number, keep: number): string[] {
  return getStorage().pruneCheckpoints(chatId, keep)
}
