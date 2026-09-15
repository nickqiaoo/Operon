// The user inbox's view of conversations waiting on a person: a pending request
// raises a `chat_needs_input` notification (user-facing turns only), and once a
// chat has none left the unread row retires. The pending state itself lives in
// chat-pending-input.ts; this is one subscriber to it. The inbox detail pane
// lists pendings via GET /ai/pending-approvals and resolves them through the
// normal POST /permission-response path like every other approval surface.

import { getChatHistoryService, getNotificationStorage } from './state.js'
import { notify, emitCounts } from '../notification-service.js'
import { emitInboxEvent } from '../channel-bus.js'
import { subscribePendingInput, type PendingApproval } from './chat-pending-input.js'

function announce(chatId: number, approval: PendingApproval, firstPending: boolean): void {
  if (!approval.userFacing) return
  const storage = getNotificationStorage()
  if (!storage) return
  const { toolName, origin } = approval
  const title = getChatHistoryService()?.getChatMeta(chatId)?.title
  notify(storage, {
    kind: 'chat_needs_input',
    severity: 'action',
    sourceKey: `chat:${chatId}`,
    chatId,
    // A turn can request several approvals back to back; only the first one takes
    // the chat from "running" to "waiting on you", so only that one is worth a
    // phone push. The rest still refresh the inbox row (the tool name in it
    // should be current) with push suppressed.
    push: firstPending,
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
 * Once a chat has no pending approvals left after an answer, retire the unread
 * needs-input row — the turn resumes, and chat_complete re-raises the same
 * sourceKey row when it finishes. A turn ending on its own leaves the row alone
 * for the same reason.
 */
function retire(chatId: number): void {
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
    console.error('[Inbox] retiring needs-input row failed:', err)
  }
}

subscribePendingInput((change) => {
  if (change.reason === 'requested') announce(change.chatId, change.approval, change.first)
  else if (change.reason === 'resolved' && change.pending.length === 0) retire(change.chatId)
})
