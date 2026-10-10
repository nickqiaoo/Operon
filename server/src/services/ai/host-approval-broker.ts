import { randomUUID } from 'node:crypto'
import type {
  PermissionDecision,
  RuntimeStreamPart,
  RuntimeTextStreamPart,
} from '@operon/agent-runtime'
import {
  alwaysApproveComputerUseApp,
  isComputerUseAppAlwaysApproved,
  isComputerUseAppBlocked,
  isComputerUseCapability,
  isComputerUseCapabilityAlwaysApproved,
  setComputerUseCapabilityApproved,
  type ComputerUseCapability,
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
/** chatId -> approval keys granted "for this conversation"; see computerUseApproval. */
/** Keyed by chat id, or by a non-chat scope such as the personal assistant (`'assistant'`). */
const sessionApprovedComputerUse = new Map<number | string, Set<string>>()

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined

/**
 * A Computer Use approval request, recognised by its metadata. Two kinds: one
 * app (`tool_params.app`, a bundle id) or one cross-app capability such as a
 * whole-screen capture (`tool_params.capability`), which no app approval covers.
 */
type ComputerUseApproval = {
  /** Session-cache key, namespaced so an app and a capability never collide. */
  key: string
  allowSession: boolean
  allowAlways: boolean
} & (
  | { kind: 'app'; app: string }
  | { kind: 'capability'; capability: ComputerUseCapability }
)

function computerUseApproval(request: HostElicitationRequest): ComputerUseApproval | undefined {
  const meta = asRecord(request.meta)
  if (meta?.connector_id !== 'computer-use') return undefined

  const persistence = Array.isArray(meta.persist)
    ? meta.persist.filter((value): value is string => typeof value === 'string')
    : []
  const allow = {
    allowSession: persistence.includes('session'),
    allowAlways: persistence.includes('always'),
  }

  const toolParams = asRecord(meta.tool_params)
  const app = typeof toolParams?.app === 'string' ? toolParams.app.trim() : ''
  if (app) return { kind: 'app', app, key: `app:${app.toLowerCase()}`, ...allow }
  const capability = toolParams?.capability
  if (isComputerUseCapability(capability)) {
    return { kind: 'capability', capability, key: `capability:${capability}`, ...allow }
  }
  return undefined
}

function isAlwaysApproved(approval: ComputerUseApproval): boolean {
  return approval.kind === 'app'
    ? isComputerUseAppAlwaysApproved(approval.app)
    : isComputerUseCapabilityAlwaysApproved(approval.capability)
}

/**
 * Answer from standing decisions without asking.
 *
 * A Settings block comes first and beats every approval, session or always.
 * This is where the block list is enforced: every Operon conversation asks
 * through here. A node_repl session with no conversation behind it asks its MCP
 * client instead, which fails closed when the client cannot ask.
 */
export function cachedComputerUseApproval(
  chatId: number | string,
  request: HostElicitationRequest,
): HostElicitationResult | undefined {
  const approval = computerUseApproval(request)
  if (!approval) return undefined

  if (approval.kind === 'app' && isComputerUseAppBlocked(approval.app)) {
    return { action: 'decline' }
  }

  const sessionApproved = approval.allowSession
    && sessionApprovedComputerUse.get(chatId)?.has(approval.key) === true
  const alwaysApproved = approval.allowAlways && isAlwaysApproved(approval)
  if (!sessionApproved && !alwaysApproved) return undefined

  return {
    action: 'accept',
    content: { source: 'computer-use-persisted-state' },
    _meta: { persist: alwaysApproved ? 'always' : 'session' },
  }
}

export function rememberComputerUseApproval(
  chatId: number | string,
  request: HostElicitationRequest,
  persist: 'session' | 'always',
): void {
  const approval = computerUseApproval(request)
  if (!approval || !approval.allowSession) return

  const approved = sessionApprovedComputerUse.get(chatId) ?? new Set<string>()
  approved.add(approval.key)
  sessionApprovedComputerUse.set(chatId, approved)

  if (persist !== 'always' || !approval.allowAlways) return
  if (approval.kind === 'app') alwaysApproveComputerUseApp(approval.app)
  else setComputerUseCapabilityApproved(approval.capability, true)
}

/** How many conversations hold "allow for this conversation" Computer Use approvals. */
export function countSessionComputerUseApprovals(): number {
  let count = 0
  for (const approved of sessionApprovedComputerUse.values()) if (approved.size > 0) count += 1
  return count
}

/** Forget every "allow for this conversation" Computer Use approval. */
/** Drop one scope's "for this session" approvals (an assistant worker that finished). */
export function forgetSessionComputerUseApprovals(scope: number | string): void {
  sessionApprovedComputerUse.delete(scope)
}

export function clearSessionComputerUseApprovals(): void {
  sessionApprovedComputerUse.clear()
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
  sessionApprovedComputerUse.clear()
}
