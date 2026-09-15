// Which conversations are blocked on a person right now, and on what.
//
// Every kind of "the agent is waiting for you" reaches the server as a
// `tool-approval-request` part: tool approvals, AskUserQuestion, plan review,
// host elicitations, and detached workflow sub-agents' requests (forwarded onto
// the conversation that launched them). This is the one registry of those, keyed
// by chat. Surfaces subscribe to it rather than to each other: the inbox raises
// notifications, the live-status stream marks tabs, external agents report
// `waiting_for_user`.
//
// Entries clear when the request is answered (POST /permission-response) or the
// turn ends. State is process-local, like the blocked turns it mirrors.

import type { RuntimeStreamPart, RuntimeTextStreamPart } from '@operon/agent-runtime'
import type { PendingInputSummary } from '../../../../shared/pending-input.js'

export type { PendingInputSummary }

export interface PendingApproval extends PendingInputSummary {
  /**
   * The asking tool's input (an `AskUserQuestion`'s `questions`, with options).
   *
   * Only carried for detached sub-agents. A normal chat renders the question from
   * the tool-call part in its own message stream; a sub-agent's stream is not on
   * screen anywhere, so the inbox has to receive the question itself in order to
   * show the form. The answer goes back through the ordinary permission response
   * as `updatedInput.answers`. Not sent on the live-status stream.
   */
  toolInput?: unknown
}

export type PendingInputChange =
  | {
      reason: 'requested'
      chatId: number
      approval: PendingApproval
      pending: PendingApproval[]
      /** The chat had nothing pending before this: it just went from working to waiting. */
      first: boolean
    }
  | { reason: 'resolved'; chatId: number; approvalId: string; pending: PendingApproval[] }
  | { reason: 'cleared'; chatId: number; pending: [] }

type ApprovalRequestPart = Extract<RuntimeTextStreamPart, { type: 'tool-approval-request' }>

const pendingByChat = new Map<number, Map<string, PendingApproval>>()
const listeners = new Set<(change: PendingInputChange) => void>()

const PREVIEW_LIMIT = 300

function emit(change: PendingInputChange): void {
  for (const listener of listeners) {
    try {
      listener(change)
    } catch (err) {
      console.error('[PendingInput] subscriber failed:', err)
    }
  }
}

export function subscribePendingInput(listener: (change: PendingInputChange) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Pending requests for one chat (empty when none — or the turn already ended). */
export function listPendingApprovals(chatId: number): PendingApproval[] {
  return [...(pendingByChat.get(chatId)?.values() ?? [])]
}

/** Every chat with something pending, for a stream's connect-time snapshot. */
export function listChatsAwaitingInput(): Array<{ chatId: number; pending: PendingInputSummary[] }> {
  return [...pendingByChat.entries()].map(([chatId, entries]) => ({
    chatId,
    pending: [...entries.values()].map(summarizePendingInput),
  }))
}

export function summarizePendingInput({ toolInput: _toolInput, ...rest }: PendingApproval): PendingInputSummary {
  return rest
}

/** Drop every pending entry for a chat (its turn started over or ended). */
export function clearPendingApprovals(chatId: number): void {
  if (!pendingByChat.delete(chatId)) return
  emit({ reason: 'cleared', chatId, pending: [] })
}

function previewOf(input: unknown): string | undefined {
  if (input == null) return undefined
  let text: string
  if (typeof input === 'string') text = input
  else if (typeof input === 'object' && !Array.isArray(input)) {
    const record = input as Record<string, unknown>
    // The field a person needs to judge the call, when the tool has an obvious one.
    const primary = ['command', 'file_path', 'path', 'url', 'pattern'].map((key) => record[key]).find((v) => typeof v === 'string')
    text = typeof primary === 'string' ? primary : JSON.stringify(input)
  } else {
    text = JSON.stringify(input)
  }
  text = text.replace(/\s+/g, ' ').trim()
  if (!text) return undefined
  return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}…` : text
}

/**
 * Watch one turn's stream parts for approval traffic. Runs server-side off the
 * assembly branch, so it keeps observing after the SSE client disconnects.
 */
export function observePendingInputPart(
  chatId: number,
  part: RuntimeStreamPart,
  options: {
    userFacing: boolean
    /** Label of the detached sub-agent that asked (see PendingApproval.origin). */
    origin?: string
    /** The asking tool's input (see PendingApproval.toolInput). */
    toolInput?: unknown
  },
): void {
  if (part.type === 'finish' || part.type === 'abort' || part.type === 'error') {
    clearPendingApprovals(chatId)
    return
  }
  if (part.type !== 'tool-approval-request') return
  const req = part as ApprovalRequestPart
  const entries = pendingByChat.get(chatId) ?? new Map<string, PendingApproval>()
  const first = entries.size === 0
  const approval: PendingApproval = {
    approvalId: req.approvalId,
    toolName: req.toolCall?.toolName || 'tool',
    requestedAt: Date.now(),
    origin: options.origin,
    toolInput: options.toolInput,
    inputPreview: previewOf(options.toolInput ?? req.toolCall?.input),
    userFacing: options.userFacing,
  }
  entries.set(req.approvalId, approval)
  pendingByChat.set(chatId, entries)
  emit({ reason: 'requested', chatId, approval, pending: [...entries.values()], first })
}

/** A request was answered (from the chat page, the inbox, a parent card, or mobile). */
export function resolvePendingApproval(chatId: number, approvalId: string): void {
  const entries = pendingByChat.get(chatId)
  if (!entries?.delete(approvalId)) return
  if (entries.size === 0) pendingByChat.delete(chatId)
  emit({ reason: 'resolved', chatId, approvalId, pending: [...entries.values()] })
}
