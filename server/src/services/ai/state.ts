import process from 'node:process'
import {
  createSessionManager,
  type SessionManager,
} from '@operon/agent-runtime'
import { ChatHistoryService } from '../chat-history.js'
import { appRuntimeHost } from './app-runtime-host.js'
import { resolveHostApproval } from './host-approval-broker.js'
import { resolveDetachedApproval } from '../agents/detached-approvals.js'
import { OperonRuntimeProvider } from '../operon-runtime/index.js'
import type { ChatStorageAdapter, ProjectStorageAdapter, NotificationStorageAdapter } from '../../storage/interface.js'

// Global guard: prevent unhandled spawn ENOENT / EPIPE errors from crashing the process.
process.on('uncaughtException', (err: Error & { code?: string; syscall?: string }) => {
  if (err?.syscall?.startsWith('spawn') && err?.code === 'ENOENT') {
    const errWithPath = err as Error & { path?: string }
    console.log(`[Adapter] Spawn failed (binary not found): ${errWithPath.path ?? err.message}`)
    return
  }
  if (err?.code === 'EPIPE') {
    return
  }
  console.error('[Uncaught Exception]', err)
})

// ---- Singleton instances ----

// Lazy-init the session manager so module load-time evaluation doesn't trip
// on the ESM circular import between runtime-provider/* and services/ai/*.
// Otherwise some provider imports land in the TDZ when this module is loaded
// transitively from inside one of those providers (e.g. via custom-provider).
let sessionManager: SessionManager | null = null
let chatStorage: ChatStorageAdapter | null = null
let chatHistoryService: ChatHistoryService | null = null
let projectStorage: Pick<ProjectStorageAdapter, 'getWorkspace'> | null = null
let notificationStorage: NotificationStorageAdapter | null = null
const _agentFinishListeners: Array<(chatId: number) => void> = []

// ---- Accessors ----

export function getSessionManager(): SessionManager {
  if (!sessionManager) {
    sessionManager = createSessionManager(appRuntimeHost, [OperonRuntimeProvider])
    // Two kinds of approval originate outside a chat session's own stream, and
    // both answer through the same `POST /permission-response`: host elicitations
    // (Browser/Computer Use, asked from inside node_repl) and detached sub-agent
    // requests (workflow `agent()`, whose session has no chatId at all). Try each
    // in turn; an id belonging to neither falls through to the normal chat lookup.
    sessionManager.setExternalPermissionResolver((chatId, approvalId, decision) =>
      resolveHostApproval(chatId, approvalId, decision) ||
      resolveDetachedApproval(chatId, approvalId, decision),
    )
  }
  return sessionManager
}

export function getChatStorage(): ChatStorageAdapter | null {
  return chatStorage
}

export function getChatHistoryService(): ChatHistoryService | null {
  return chatHistoryService
}

export function getProjectStorage(): Pick<ProjectStorageAdapter, 'getWorkspace'> | null {
  return projectStorage
}

/** The user notification inbox store, if the injected storage supports it. */
export function getNotificationStorage(): NotificationStorageAdapter | null {
  return notificationStorage
}

export function getAgentFinishCallback(): ((chatId: number) => void) | null {
  if (_agentFinishListeners.length === 0) return null
  return (chatId: number) => {
    for (const listener of _agentFinishListeners) {
      try {
        listener(chatId)
      } catch (err) {
        console.error('[AI] agent finish listener error:', err)
      }
    }
  }
}

export function registerAgentFinishCallback(cb: (chatId: number) => void): void {
  _agentFinishListeners.push(cb)
}

// ---- Init & Shutdown ----

const hasWorkspaceLookup = (
  storage: Partial<ProjectStorageAdapter>
): storage is Pick<ProjectStorageAdapter, 'getWorkspace'> =>
  typeof storage.getWorkspace === 'function'

const hasNotifications = (
  storage: Partial<NotificationStorageAdapter>
): storage is NotificationStorageAdapter =>
  typeof storage.notificationUpsert === 'function'

export function initAiService(
  storage: ChatStorageAdapter & Partial<ProjectStorageAdapter> & Partial<NotificationStorageAdapter>,
): void {
  chatStorage = storage
  chatHistoryService = new ChatHistoryService(storage)
  if (hasWorkspaceLookup(storage)) {
    projectStorage = storage
  }
  if (hasNotifications(storage)) {
    notificationStorage = storage
  }
}

export async function shutdown(): Promise<void> {
  if (!sessionManager) return
  await sessionManager.destroyAll()
}
