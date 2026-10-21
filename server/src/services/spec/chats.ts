/**
 * The conversations a spec owns, as links its panel can open.
 *
 * A spec's agents and tickets each ran as an ordinary chat; the spec only keeps
 * their ids. A chat opens in its own workspace, and in the spec's once that one
 * is gone — a ticket's worktree is removed when the ticket lands, and its code
 * now lives on the spec's change branch, which is where to pick it back up.
 */

import type { ChatStorageAdapter, ProjectStorageAdapter } from '../../storage/interface.js'
import type { SpecChatRef } from '../../types/spec.js'

/** Chats are read when the storage has them (the app's always does; a test's may not). */
export type SpecChatStorage = Pick<ProjectStorageAdapter, 'getWorkspace'> & Partial<Pick<ChatStorageAdapter, 'getChatMeta'>>

export function specChatRef(storage: SpecChatStorage, chatId: number, fallbackWorkspaceId: number | null): SpecChatRef | null {
  const meta = storage.getChatMeta?.(chatId)
  if (!meta) return null
  const own = meta.workspaceId != null && storage.getWorkspace(meta.workspaceId) ? meta.workspaceId : null
  return {
    chatId,
    title: meta.title?.trim() || 'Chat',
    providerId: meta.providerId ?? null,
    workspaceId: own ?? fallbackWorkspaceId,
    subAgent: meta.tp === 'subagent' || meta.tp === 'workflow-agent',
    updatedAt: meta.updatedAt,
  }
}

export function specChatRefs(storage: SpecChatStorage, chatIds: readonly number[], fallbackWorkspaceId: number | null): SpecChatRef[] {
  return chatIds.flatMap((id) => specChatRef(storage, id, fallbackWorkspaceId) ?? [])
}
