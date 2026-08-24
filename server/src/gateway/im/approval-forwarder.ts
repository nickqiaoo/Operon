import type { TextStreamPart, ToolSet } from 'ai'
import type { PermissionHandler } from './permission-handler.js'
import type { ChannelRef, IMProvider } from './types.js'

type FullStreamEvent = TextStreamPart<ToolSet>
type ApprovalRequestEvent = Extract<FullStreamEvent, { type: 'tool-approval-request' }>

export interface ForwardApprovalEventArgs {
  event: ApprovalRequestEvent
  handler: PermissionHandler
  provider: IMProvider
  ref: ChannelRef
  channelKey: string
  internalChatId: number
}

/**
 * Shared approval event → IM button bridge.
 *
 * Interactive mode (chat-consumer) and mate mode (mate-orchestrator drain)
 * both receive `tool-approval-request` events from the provider stream and
 * need identical dispatch: register pending with the handler, then render
 * Allow/Always/Deny buttons (or AskUserQuestion choices for ask_user tools).
 *
 * PermissionHandler itself is provider-agnostic and IM-agnostic; the only
 * mode-specific piece is picking the ChannelRef (mate reads lastWakeChannel,
 * interactive already has a per-turn ref).
 */
export async function forwardApprovalEvent(args: ForwardApprovalEventArgs): Promise<void> {
  const { event, handler, provider, ref, channelKey, internalChatId } = args
  const approvalId = event.approvalId
  const toolName = event.toolCall.toolName
  const input = toInputRecord(event.toolCall.input)

  handler.addPending({
    approvalId,
    chatId: internalChatId,
    channelKey,
    ref,
    toolName,
    input,
  })

  if (toolName === 'AskUserQuestion' || toolName === 'ask_user') {
    await handler.sendAskUserQuestion(provider, ref, approvalId, input)
  } else {
    await handler.sendPermissionRequest(provider, ref, approvalId, toolName, input)
  }
}

function toInputRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null) return value as Record<string, unknown>
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>
    } catch { /* not JSON */ }
  }
  return {}
}
