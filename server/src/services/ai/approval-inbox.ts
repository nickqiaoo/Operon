// In-memory tracker of each chat's pending tool approvals, feeding the user
// inbox: a pending approval raises a `chat_needs_input` notification (user-
// facing workspace chats only) and is listed via GET /ai/pending-approvals so
// the inbox detail pane can Approve/Deny inline — resolution goes through the
// normal POST /permission-response path like every other approval surface.
// Entries clear when the approval resolves or the turn ends. State is
// process-local, like the blocked turns it mirrors.

import type { RuntimeStreamPart, RuntimeTextStreamPart } from '@operon/agent-runtime'
import { getChatHistoryService, getNotificationStorage } from './state.js'
import { notify, emitCounts } from '../notification-service.js'
import { emitInboxEvent } from '../channel-bus.js'

export interface PendingApproval {
  approvalId: string
  toolName: string
  requestedAt: number
  /**
   * Set when the request came from a detached sub-agent rather than this chat's
   * own turn (workflow `agent()`). The chat is the launching conversation, not
   * the one doing the work, so the UI has to say whose request this is.
   */
  origin?: string
  /**
   * The asking tool's input (an `AskUserQuestion`'s `questions`, with options).
   *
   * Only carried for detached sub-agents. A normal chat renders the question from
   * the tool-call part in its own message stream; a sub-agent's stream is not on
   * screen anywhere, so the inbox has to receive the question itself in order to
   * show the form. The answer goes back through the ordinary permission response
   * as `updatedInput.answers`.
   */
  toolInput?: unknown
}

type ApprovalRequestPart = Extract<RuntimeTextStreamPart, { type: 'tool-approval-request' }>

const pendingByChat = new Map<number, Map<string, PendingApproval>>()

/** Pending approvals for one chat (empty when none — or the turn already ended). */
export function listPendingApprovals(chatId: number): PendingApproval[] {
  return [...(pendingByChat.get(chatId)?.values() ?? [])]
}

/** Drop every pending entry for a chat (a new turn is starting). */
export function clearPendingApprovals(chatId: number): void {
  pendingByChat.delete(chatId)
}

/**
 * Watch one turn's stream parts for approval traffic. Runs server-side off the
 * assembly branch, so it keeps observing after the SSE client disconnects.
 * `notifyInbox` is true only on the user-facing workspace-chat path — background
 * turns (channel/task/cron) still track pendings but never raise notifications.
 */
export function observeApprovalPart(
  chatId: number,
  part: RuntimeStreamPart,
  notifyInbox: boolean,
  /**
   * Label of the detached sub-agent that asked, when the request is not this
   * chat's own (see PendingApproval.origin).
   */
  origin?: string,
  /** The asking tool's input, so the inbox can render the form (see PendingApproval.toolInput). */
  toolInput?: unknown,
): void {
  if (part.type === 'finish' || part.type === 'abort' || part.type === 'error') {
    pendingByChat.delete(chatId)
    return
  }
  if (part.type !== 'tool-approval-request') return
  const req = part as ApprovalRequestPart
  const toolName = req.toolCall?.toolName || 'tool'
  const entries = pendingByChat.get(chatId) ?? new Map<string, PendingApproval>()
  // A turn can request several approvals back to back; only the first one takes
  // the chat from "running" to "waiting on you", so only that one is worth a
  // phone push. The rest still refresh the inbox row (the tool name in it
  // should be current) with push suppressed.
  const wasIdle = entries.size === 0
  entries.set(req.approvalId, {
    approvalId: req.approvalId,
    toolName,
    requestedAt: Date.now(),
    origin,
    toolInput,
  })
  pendingByChat.set(chatId, entries)

  if (!notifyInbox) return
  const storage = getNotificationStorage()
  if (!storage) return
  const title = getChatHistoryService()?.getChatMeta(chatId)?.title
  notify(storage, {
    kind: 'chat_needs_input',
    severity: 'action',
    sourceKey: `chat:${chatId}`,
    chatId,
    push: wasIdle,
    title: title?.trim() || 'Workspace chat',
    // Name the sub-agent: this conversation launched a workflow and is now idle,
    // so an unattributed "waiting for approval" reads as if the chat itself were
    // stuck.
    body: origin
      ? toolName === 'AskUserQuestion'
        ? `Sub-agent ${origin} asked you a question`
        : `Sub-agent ${origin} is waiting for approval · ${toolName}`
      : toolName === 'AskUserQuestion'
        ? 'The agent asked you a question'
        : toolName === 'ExitPlanMode'
          ? 'The agent proposed a plan for review'
          : `Waiting for approval · ${toolName}`,
  })
}

/**
 * An approval was answered (from the chat page, the inbox, or mobile). Once the
 * chat has no pending approvals left, retire the unread needs-input row — the
 * turn resumes, and chat_complete re-raises the same sourceKey row when it
 * finishes.
 */
export function resolvePendingApproval(chatId: number, approvalId: string): void {
  const entries = pendingByChat.get(chatId)
  if (!entries?.delete(approvalId)) return
  if (entries.size > 0) return
  pendingByChat.delete(chatId)
  const storage = getNotificationStorage()
  if (!storage) return
  try {
    const readIds = storage.notificationMarkReadBySource(`chat:${chatId}`, 'chat_needs_input')
    for (const id of readIds) {
      const row = storage.notificationGet(id)
      if (row) emitInboxEvent({ type: 'notification_upsert', notification: row })
    }
    if (readIds.length > 0) emitCounts(storage)
  } catch (err) {
    console.error('[Inbox] resolvePendingApproval failed:', err)
  }
}
