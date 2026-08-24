import { randomUUID } from 'node:crypto'
import type {
  PermissionDecision,
  RuntimeStreamPart,
  RuntimeTextStreamPart,
} from '@operon/agent-runtime'
import {
  alwaysApproveComputerUseApp,
  isComputerUseAppAlwaysApproved,
} from '../computer-use-config.js'

export interface HostElicitationRequest {
  message: string
  meta?: unknown
}

export interface HostElicitationResult {
  action: 'accept' | 'decline' | 'cancel'
  content?: {
    persist?: 'session' | 'always'
    source?: 'computer-use-persisted-state'
  }
  _meta?: {
    persist?: 'session' | 'always'
    approvals_reviewer?: 'auto_review' | 'guardian_subagent'
  }
}

type StreamSink = (part: RuntimeTextStreamPart) => void
type ToolCallPart = Extract<RuntimeTextStreamPart, { type: 'tool-call' }>

interface StreamBinding {
  token: symbol
  emit: StreamSink
  activeToolCalls: Map<string, ToolCallPart>
}

interface PendingApproval {
  chatId: number
  toolCallId: string
  emit: StreamSink
  request: HostElicitationRequest
  resolve: (result: HostElicitationResult) => void
  /**
   * Set only when the card was synthesized here. A provider-owned call closes
   * itself when the tool returns; a synthesized one has no such owner, so the
   * decision has to close it or it stays "waiting for approval" forever.
   */
  synthesized?: ToolCallPart
}

const streams = new Map<number, StreamBinding>()
const pending = new Map<string, PendingApproval>()
const sessionApprovedComputerUseApps = new Map<number, Set<string>>()

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined

interface ComputerUseApproval {
  app: string
  key: string
  allowSession: boolean
  allowAlways: boolean
}

function computerUseApproval(request: HostElicitationRequest): ComputerUseApproval | undefined {
  const meta = asRecord(request.meta)
  if (meta?.connector_id !== 'computer-use') return undefined

  const toolParams = asRecord(meta.tool_params)
  const app = typeof toolParams?.app === 'string' ? toolParams.app.trim() : ''
  if (!app) return undefined

  const persistence = Array.isArray(meta.persist)
    ? meta.persist.filter((value): value is string => typeof value === 'string')
    : []
  return {
    app,
    key: app.toLowerCase(),
    allowSession: persistence.includes('session'),
    allowAlways: persistence.includes('always'),
  }
}

function cachedComputerUseApproval(
  chatId: number,
  request: HostElicitationRequest,
): HostElicitationResult | undefined {
  const approval = computerUseApproval(request)
  if (!approval) return undefined

  const sessionApproved = approval.allowSession
    && sessionApprovedComputerUseApps.get(chatId)?.has(approval.key) === true
  const alwaysApproved = approval.allowAlways
    && isComputerUseAppAlwaysApproved(approval.app)
  if (!sessionApproved && !alwaysApproved) return undefined

  return {
    action: 'accept',
    content: { source: 'computer-use-persisted-state' },
    _meta: { persist: alwaysApproved ? 'always' : 'session' },
  }
}

function rememberComputerUseApproval(
  chatId: number,
  request: HostElicitationRequest,
  persist: 'session' | 'always',
): void {
  const approval = computerUseApproval(request)
  if (!approval || !approval.allowSession) return

  const approvedApps = sessionApprovedComputerUseApps.get(chatId) ?? new Set<string>()
  approvedApps.add(approval.key)
  sessionApprovedComputerUseApps.set(chatId, approvedApps)

  if (persist === 'always' && approval.allowAlways) {
    alwaysApproveComputerUseApp(approval.app)
  }
}

function isNodeReplToolCall(call: ToolCallPart): boolean {
  if (call.toolName.toLowerCase().includes('node_repl')) return true
  const input = asRecord(call.input)
  const delegatedName = input?.tool_name ?? input?.toolName
  return typeof delegatedName === 'string' && delegatedName.toLowerCase().includes('node_repl')
}

function approvalToolCall(stream: StreamBinding): ToolCallPart | undefined {
  const active = [...stream.activeToolCalls.values()]
  for (let index = active.length - 1; index >= 0; index -= 1) {
    if (isNodeReplToolCall(active[index])) return active[index]
  }
  return active.at(-1)
}

/**
 * Build a self-describing tool call when no provider call is available to host
 * the approval.
 *
 * This is the normal case, not an edge case. Browser/Computer Use ask from
 * inside node_repl while the outer tool is still running, and providers only
 * emit `tool-call` once that tool finishes (see the claude builder's
 * `emitToolCall` call sites). Waiting for a host would deadlock: the tool
 * cannot finish until the approval resolves.
 *
 * The elicitation's own metadata is richer than the outer call anyway — the
 * user is deciding about `access_browser_origin`, not about "node_repl is
 * running some JS" — so the synthesized card reads better than the host it
 * replaces. Mirrors what the codex emitter already does when an approval
 * arrives without a matching emitted call.
 */
function synthesizeToolCall(approvalId: string, request: HostElicitationRequest): ToolCallPart {
  const meta = asRecord(request.meta)
  const toolName = [meta?.tool_name, meta?.connector_id]
    .find((value): value is string => typeof value === 'string' && value.length > 0)
    ?? 'permission-request'
  const params = asRecord(meta?.tool_params) ?? {}

  return {
    type: 'tool-call',
    toolCallId: approvalId,
    toolName,
    input: params,
    providerExecuted: true,
    dynamic: true,
  } as ToolCallPart
}

function cancelPendingForChat(chatId: number): void {
  for (const [approvalId, approval] of pending) {
    if (approval.chatId !== chatId) continue
    pending.delete(approvalId)
    approval.resolve({ action: 'cancel' })
  }
}

/**
 * Attach the active agent-turn stream for one chat.
 *
 * Browser/Computer Use permissions originate inside node_repl, outside the
 * provider's own stream. Injecting them here keeps one provider-independent UI
 * path and also lets mobile/IM consumers observe the same approval parts.
 */
export function attachHostApprovalStream(chatId: number, emit: StreamSink): () => void {
  const token = Symbol(`host-approval-${chatId}`)
  const previous = streams.get(chatId)
  if (previous) cancelPendingForChat(chatId)
  streams.set(chatId, { token, emit, activeToolCalls: new Map() })

  return () => {
    if (streams.get(chatId)?.token !== token) return
    streams.delete(chatId)
    cancelPendingForChat(chatId)
  }
}

/**
 * Keep the host bridge correlated with provider-owned tool calls.
 *
 * Browser/Computer Use asks for approval from inside node_repl, after the outer
 * provider tool has started. The elicitation itself therefore has no provider
 * toolCallId. Tracking the still-running calls lets the approval update that
 * existing card instead of synthesizing a second "permission" tool card.
 */
export function observeHostApprovalStreamPart(chatId: number, part: RuntimeStreamPart): void {
  const stream = streams.get(chatId)
  if (!stream) return

  if (part.type === 'tool-call') {
    stream.activeToolCalls.set(part.toolCallId, part)
    return
  }

  if (
    part.type === 'tool-error' ||
    part.type === 'tool-output-denied' ||
    (part.type === 'tool-result' && !part.preliminary)
  ) {
    stream.activeToolCalls.delete(part.toolCallId)
    return
  }

  if (part.type === 'finish' || part.type === 'abort') {
    stream.activeToolCalls.clear()
  }
}

/**
 * Ask the Operon host UI instead of relying on an external MCP client's optional
 * `elicitation/create` support.
 */
export function requestHostElicitation(
  chatId: number,
  request: HostElicitationRequest,
): Promise<HostElicitationResult> {
  const cached = cachedComputerUseApproval(chatId, request)
  if (cached) return Promise.resolve(cached)

  const stream = streams.get(chatId)
  if (!stream) return Promise.resolve({ action: 'cancel' })

  const approvalId = randomUUID()
  // Prefer the owning provider call so the approval updates that existing card.
  // When there is none, stand the request up on its own rather than failing
  // closed — an unanswerable prompt reads to the user as "denied" for a
  // decision they were never shown.
  const owningToolCall = approvalToolCall(stream)
  const ownerAlreadyAwaitingApproval = owningToolCall !== undefined && [...pending.values()].some(
    (approval) => approval.chatId === chatId && approval.toolCallId === owningToolCall.toolCallId,
  )
  // AI SDK stores one current approval on each tool part. Reusing an owning call
  // for two concurrent host requests would overwrite the first approvalId and make
  // it impossible to answer. Keep the first request on the owner; give additional
  // concurrent requests their own self-describing cards.
  const toolCall = owningToolCall && !ownerAlreadyAwaitingApproval
    ? owningToolCall
    : synthesizeToolCall(approvalId, request)
  const synthesized = toolCall !== owningToolCall

  // Deliberately no timeout: the turn is blocked inside the tool call until the
  // user answers, and expiring on their behalf is indistinguishable from a
  // refusal. Abandoned approvals are still released by `cancelPendingForChat`
  // when the turn's stream detaches.
  return new Promise<HostElicitationResult>((resolve) => {
    pending.set(approvalId, {
      chatId,
      toolCallId: toolCall.toolCallId,
      emit: stream.emit,
      request,
      resolve,
      ...(synthesized ? { synthesized: toolCall } : {}),
    })
    // An approval attaches to an existing tool call — consumers look the id up
    // in the message assembled so far. The owning call has already travelled
    // the stream; a synthesized one has not, so emit it first exactly as a
    // provider would. Skipping this makes the SDK assembler throw
    // "No tool invocation found for tool call ID" and drop the turn.
    if (synthesized) stream.emit(toolCall)
    stream.emit({
      type: 'tool-approval-request',
      approvalId,
      toolCall,
    } as RuntimeTextStreamPart)
  })
}

/**
 * Resolve a host-originated approval before falling back to the provider's own
 * pending permission map.
 */
export function resolveHostApproval(
  chatId: number,
  approvalId: string,
  decision: PermissionDecision,
): boolean {
  const approval = pending.get(approvalId)
  if (!approval || approval.chatId !== chatId) return false

  pending.delete(approvalId)

  if (decision.type === 'deny') {
    closeSynthesizedCall(approval, 'deny')
    approval.resolve({ action: 'decline' })
    return true
  }

  const persist = decision.type === 'allow-always' ? 'always' : 'session'
  rememberComputerUseApproval(chatId, approval.request, persist)
  closeSynthesizedCall(approval, 'allow')
  approval.resolve({ action: 'accept', _meta: { persist } })
  return true
}

/**
 * Settle a card this broker invented. The real work happens back inside the
 * still-running provider tool, so the card's only remaining job is to stop
 * reading as pending — hence a bare acknowledgement rather than a tool result.
 */
function closeSynthesizedCall(approval: PendingApproval, decision: 'allow' | 'deny'): void {
  const toolCall = approval.synthesized
  if (!toolCall) return

  if (decision === 'deny') {
    approval.emit({ type: 'tool-output-denied', toolCallId: toolCall.toolCallId } as RuntimeTextStreamPart)
    return
  }
  approval.emit({
    type: 'tool-result',
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
    input: toolCall.input,
    output: { approved: true },
    providerExecuted: true,
    dynamic: true,
  } as RuntimeTextStreamPart)
}

/** Test-only reset; intentionally not used by production lifecycle code. */
export function resetHostApprovalBroker(): void {
  for (const approval of pending.values()) {
    approval.resolve({ action: 'cancel' })
  }
  pending.clear()
  streams.clear()
  sessionApprovedComputerUseApps.clear()
}
