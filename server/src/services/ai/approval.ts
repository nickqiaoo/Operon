import type { UIMessage } from 'ai'
import type { PermissionDecision } from '@operon/agent-runtime'
import type { ApprovalResponseSnapshot, PermissionOutcome, PermissionOutcomeKind } from './types.js'
import { getSessionManager } from './state.js'
import { resolvePendingApproval } from './approval-inbox.js'

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isToolLikePart = (value: unknown): value is Record<string, unknown> => {
  if (!isObjectRecord(value)) return false
  const type = value.type
  return typeof type === 'string' && (type === 'dynamic-tool' || type.startsWith('tool-'))
}

export const getApprovalResponseSnapshot = (message: UIMessage | undefined): ApprovalResponseSnapshot | null => {
  if (!message || message.role !== 'assistant') return null

  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index]
    if (!isToolLikePart(part)) continue
    const partRecord = part as Record<string, unknown>

    const approval = isObjectRecord(partRecord.approval) ? partRecord.approval : null
    const approvalId = typeof approval?.id === 'string' ? approval.id : null
    const approved = typeof approval?.approved === 'boolean' ? approval.approved : null
    if (!approvalId || approved === null) continue

    return {
      approvalId,
      approved,
      reason: approval && typeof approval.reason === 'string' ? approval.reason : undefined,
      state: typeof partRecord.state === 'string' ? partRecord.state : 'approval-responded',
    }
  }

  return null
}

export function applyApprovalResponseToHistory(
  dbHistory: UIMessage[],
  response: ApprovalResponseSnapshot,
): { assistantIndex: number; assistantMessage: UIMessage; nextHistory: UIMessage[] } | null {
  for (let messageIndex = dbHistory.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = dbHistory[messageIndex]
    if (message.role !== 'assistant') continue

    let matched = false
    const nextParts = message.parts.map<UIMessage['parts'][number]>((part) => {
      if (!isToolLikePart(part)) return part
      const partRecord = part as Record<string, unknown>
      const approval = isObjectRecord(partRecord.approval) ? partRecord.approval : null
      if (approval?.id !== response.approvalId) return part

      matched = true
      return {
        ...part,
        state: response.state,
        approval: {
          id: response.approvalId,
          approved: response.approved,
          ...(response.reason ? { reason: response.reason } : {}),
        },
      } as typeof part
    })

    if (!matched) continue

    const assistantMessage: UIMessage = {
      ...message,
      parts: nextParts,
    }
    return {
      assistantIndex: messageIndex,
      assistantMessage,
      nextHistory: [
        ...dbHistory.slice(0, messageIndex),
        assistantMessage,
        ...dbHistory.slice(messageIndex + 1),
      ],
    }
  }

  return null
}

const isPermissionOutcomeObject = (
  outcome: PermissionOutcome | unknown
): outcome is { outcome: PermissionOutcomeKind; reason?: string; updatedInput?: Record<string, unknown> } => {
  if (!outcome || typeof outcome !== 'object') return false
  const record = outcome as { outcome?: unknown }
  return record.outcome === 'allow' || record.outcome === 'deny' || record.outcome === 'allowAlways'
}

export function handlePermissionResponse(id: string, outcome: PermissionOutcome, chatId: number): boolean {
  const sessionManager = getSessionManager()
  let decision: PermissionDecision
  if (outcome === 'allow' || (isPermissionOutcomeObject(outcome) && outcome.outcome === 'allow')) {
    const updatedInput = isPermissionOutcomeObject(outcome) ? outcome.updatedInput : undefined
    decision = { type: 'allow', updatedInput }
  } else if (outcome === 'deny' || (isPermissionOutcomeObject(outcome) && outcome.outcome === 'deny')) {
    const reason = isPermissionOutcomeObject(outcome) ? outcome.reason : undefined
    decision = { type: 'deny', reason }
  } else if (outcome === 'allowAlways' || (isPermissionOutcomeObject(outcome) && outcome.outcome === 'allowAlways')) {
    const updatedInput = isPermissionOutcomeObject(outcome) ? outcome.updatedInput : undefined
    decision = { type: 'allow-always', updatedInput }
  } else {
    decision = { type: 'allow' }
  }
  const resolved = sessionManager.resolvePermission(chatId, id, decision)
  if (resolved) resolvePendingApproval(chatId, id)
  return resolved
}
