import type { MemoryMaintenanceStorageAdapter } from '../../storage/interface.js'

export interface LoadedMessage {
  messageIndex: number
  payload: {
    id?: string
    role?: string
    parts?: unknown[]
    metadata?: unknown
  }
}

/**
 * Load chat messages strictly above the watermark, ordered ascending by
 * message_index. A soft cap prevents pathological one-shot loads on
 * chats with hundreds of thousands of messages — in that case we process
 * the first `limit` incremental messages and let the next maintenance
 * run pick up the rest.
 */
export function loadMessagesAfter(
  storage: MemoryMaintenanceStorageAdapter,
  chatId: number,
  afterIndex: number | null,
  limit = 2000
): LoadedMessage[] {
  const rows = storage.getChatMessagesWithIndex(chatId, { afterIndex, limit })
  return rows.map((row) => ({
    messageIndex: row.messageIndex,
    payload: (row.payload as LoadedMessage['payload']) ?? {},
  }))
}
