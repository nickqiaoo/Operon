/**
 * Something a conversation is blocked on until a person answers: a tool
 * approval, an AskUserQuestion, a plan review, or a detached sub-agent's request
 * forwarded onto the conversation that launched it. Carried per chat on the
 * live-status stream (`GET /api/ai/chat/live-status`).
 */
export interface PendingInputSummary {
  approvalId: string
  toolName: string
  requestedAt: number
  /** Label of the detached sub-agent that asked, when it was not the chat's own turn. */
  origin?: string
  /** One line of what is being asked, for surfaces that approve without the transcript. */
  inputPreview?: string
  /** Raised by a turn a person drives; background turns are tracked but not announced. */
  userFacing: boolean
}

/** Needs the conversation's own UI (a form or a plan), not a plain allow / deny. */
export function needsConversationToAnswer(pending: Pick<PendingInputSummary, 'toolName' | 'approvalId'>): boolean {
  return (
    pending.toolName === 'AskUserQuestion' ||
    pending.toolName === 'ExitPlanMode' ||
    pending.approvalId.startsWith('plan-approval-')
  )
}
