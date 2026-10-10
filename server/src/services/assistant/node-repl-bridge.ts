/**
 * Who is calling: the assistant's own MCP route (routes/assistant-mcp.ts) and node_repl (browser,
 * Chrome, Computer Use, site adapters) both need to know which of the assistant's sessions made
 * a call. Imported by the routes and the assistant runtime, so it depends on neither.
 *
 * Every session the assistant opens gets URLs naming it — role and, for a worker, its activity id
 * — plus a per-process key, so a URL is believed only when it came from the assistant itself: a
 * coding chat's model cannot claim to be a worker and borrow the assistant's approvals.
 *
 * OpenCode is the exception. It shares one MCP client per server name across every session in a
 * directory, so the URL is whichever session registered first. There the call carries the calling
 * OpenCode session instead (agent-runtime caller-identity.ts), which the runtime bound to one of
 * the conversation ids below when it opened the session (`hostConversationId`).
 */
import { randomBytes, timingSafeEqual } from 'crypto'
import type { HostElicitationRequest, HostElicitationResult } from '../ai/host-approval-broker.js'

/** Session-key prefix for an assistant worker's node_repl context. */
export const ASSISTANT_NODE_REPL_PREFIX = 'assistant:'

/** Query parameter carrying this process's key on every URL the assistant hands out. */
export const ASSISTANT_KEY_PARAM = 'assistantKey'
/** Query parameter naming the worker on its node_repl URL. */
export const ASSISTANT_WORKER_PARAM = 'assistantWorker'
const ASSISTANT_KEY = randomBytes(24).toString('hex')

/** `assistantKey=…` for a URL the assistant hands to one of its sessions. */
export function assistantKeyQuery(): string {
  return `${ASSISTANT_KEY_PARAM}=${ASSISTANT_KEY}`
}

/** Whether a request's key is this process's — i.e. the URL came from the assistant. */
export function isAssistantMountKey(value: string | undefined): boolean {
  if (!value) return false
  const given = Buffer.from(value)
  const expected = Buffer.from(ASSISTANT_KEY)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/** A worker or helper id as it may appear in a URL or a key. */
export function isAssistantId(value: string | undefined): value is string {
  return typeof value === 'string' && /^[\w-]{1,80}$/.test(value)
}

/** The kinds of session the assistant opens. */
export type AssistantRole = 'main' | 'worker' | 'wrapup'

export interface AssistantCaller {
  role: AssistantRole
  /** The worker's activity id, or the wrap-up's own id. Absent for the main agent. */
  id?: string
}

/** The host conversation id an assistant session is bound to (OpenCode caller identity). */
export function assistantConversationId(caller: AssistantCaller): string {
  return caller.role === 'main' ? 'assistant:main' : `assistant:${caller.role}:${caller.id ?? ''}`
}

/** The inverse of `assistantConversationId`; undefined for anything else (a chat id). */
export function parseAssistantConversation(value: string | undefined): AssistantCaller | undefined {
  if (value === 'assistant:main') return { role: 'main' }
  const match = /^assistant:(worker|wrapup):(.+)$/.exec(value ?? '')
  if (!match || !isAssistantId(match[2])) return undefined
  return { role: match[1] as AssistantRole, id: match[2] }
}

export type AssistantElicitationHandler = (
  workerId: string,
  request: HostElicitationRequest,
) => Promise<HostElicitationResult>

let handler: AssistantElicitationHandler | undefined

/** The assistant runtime answers its workers' permission prompts (approval cards). */
export function setAssistantElicitationHandler(next: AssistantElicitationHandler | undefined): void {
  handler = next
}

/**
 * A worker's node_repl wants permission (a new site, an app). Without a live assistant there is
 * nobody to ask, so the answer is "not answered" — never the kernel's default of allowing.
 */
export function requestAssistantElicitation(workerId: string, request: HostElicitationRequest): Promise<HostElicitationResult> {
  return handler ? handler(workerId, request) : Promise.resolve({ action: 'cancel' })
}
