import { base64ToBytes, bytesToBase64 } from './e2ee/protocol.js'

/**
 * Remote external agents: a conversation on one machine whose agent runs on another
 * machine of the same account.
 *
 * The conversation itself is an ordinary sub-agent chat on the machine that started
 * it (the origin) — same tab, composer, transcript, approvals and result delivery as
 * a local external agent. Only its agent session lives elsewhere: the origin's
 * session forwards each turn to the target, which runs the provider in one of its
 * own workspaces and streams the runtime's parts back. The target keeps no chat.
 */

export const DELEGATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const DELEGATION_NODE_ID = /^[0-9a-f]{32}$/
export const DELEGATION_PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

/** Where a remote external agent runs. Saved on the origin's chat. */
export interface RemoteExecutionRef {
  /** The target machine's Broker node id. */
  nodeId: string
  /** Its label when the agent was created, for display. */
  machine: string
  /** The workspace on the target machine, and its "project / workspace" label. */
  workspaceId: number
  workspace: string
  /** Names the agent session on the target; stable for the life of the conversation. */
  sessionId: string
}

export interface DelegationMachine {
  nodeId: string
  label: string
  online: boolean
  current: boolean
}

export interface DelegationWorkspace {
  id: number
  name: string
  project: string
}

/** Session settings the origin's chat carries, in the provider's own vocabulary. */
export interface DelegationSessionOptions {
  model?: string
  mode?: string
  effort?: string
  serviceTier?: 'fast'
  resume?: string
}

/** POST /api/delegations/sessions/:id/turn — answered with an SSE stream of `DelegationFrame`. */
export interface DelegationTurnRequest {
  providerId: string
  workspaceId: number
  options: DelegationSessionOptions
  /** The turn's `AgentInput`, wire-encoded (see `encodeWire`). */
  input: unknown
}

/** POST /api/delegations/sessions/:id/control */
export type DelegationControl =
  | { type: 'respond'; approvalId: string; decision: unknown }
  | { type: 'abort' }
  | { type: 'close' }
  | { type: 'set'; patch: Omit<DelegationSessionOptions, 'serviceTier' | 'resume'> & { serviceTier?: 'fast' | null } }
  | { type: 'steer' | 'followup'; input: unknown; id?: string }

export type DelegationControlResult =
  | { ok: true; accepted?: boolean; applied?: string[]; receipt?: unknown; state?: unknown }

/** One SSE event of a turn stream. */
export type DelegationFrame =
  | { type: 'part'; part: unknown }
  | { type: 'state'; state: unknown }
  | { type: 'error'; message: string }

export interface IncomingDelegation {
  sessionId: string
  sourceNodeId: string
  sourceLabel?: string
  providerId: string
  workspace?: string
  status: 'running' | 'idle' | 'closed'
  updatedAt: number
}

// ── External agents across machines ─────────────────────────────────────────
//
// A conversation on one machine (the origin) starts an external agent on
// another (the target). The agent's conversation is an ordinary external agent
// of the target: its chat, workspace, turns and approvals are all there. The
// origin keeps a record of it for its parent conversation (the Agents card,
// `external_agent_send/stop/status`), and the target reports each turn back.

/** On the target: the conversation on another machine that started this agent. */
export interface RemoteAgentParent {
  /** The origin's Broker node id (stamped by Broker, never taken from a request body). */
  nodeId: string
  label?: string
  /** The parent conversation, a chat id on the origin. */
  chatId: number
}

/** POST /api/delegations/agents (origin → target) */
export interface DelegatedAgentCreate {
  parentChatId: number
  providerId: string
  model: string
  effort?: string
  description: string
  prompt: string
  workspaceId: number
}

/** What the target answers: its own ids, which the origin maps to its record. */
export interface DelegatedAgentStarted {
  childChatId: number
  workspaceId: number
  providerId: string
  modelId?: string
  modeId?: string
  turnId: string
  status: 'running' | 'queued'
  delivery?: string
  warning?: string
}

/** POST /api/delegations/agents/:childChatId/(send|stop|status) — who is asking, on the origin. */
export interface DelegatedAgentCall {
  parentChatId: number
  prompt?: string
  mode?: 'auto' | 'steer' | 'followup'
}

/**
 * POST /api/delegations/agent-events (target → origin): a turn of the agent
 * started, or finished with its result. Accepted even while the origin does not
 * serve other machines, but only for agents it started there.
 */
export type DelegatedAgentEvent =
  | { type: 'turn'; childChatId: number; turnId: string; status: 'running' | 'queued' }
  | {
      type: 'result'
      childChatId: number
      turnId: string
      status: 'completed' | 'cancelled' | 'failed'
      error?: string
      /** The turn's prompt came from the parent agent, not from someone typing in the agent's chat. */
      dispatched: boolean
      prompt: string
      result: string
      /** Set when the agent works in a workspace of its own on the target. */
      workspace?: { id: number; branch: string; worktreePath: string }
    }

/** The one path another machine may call here while this machine serves no others. */
export const DELEGATED_AGENT_EVENTS_PATH = '/api/delegations/agent-events'

/** An origin's id for an agent it started on another machine: `ext-r<first 8 of node>-<child chat id>`. */
export const REMOTE_AGENT_ID = /^ext-r([0-9a-f]{8})-(\d+)$/

export function remoteAgentId(nodeId: string, childChatId: number): string {
  return `ext-r${nodeId.slice(0, 8)}-${childChatId}`
}

const NODE_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * What another machine may never call here, even with receiving turned on: the
 * settings that decide who may reach this machine (paired devices, the Broker
 * connection, the receive switch itself), the relay on to a third machine, and
 * Broker's own webhook deliveries.
 */
const NODE_DENIED = /^\/api\/(e2ee|saas|remote|delegations\/local|integrations\/events)(\/|$)/

/**
 * Every path one machine may call on another (checked by the target and by
 * Broker). A machine that turned on "Run agents for other machines" serves the
 * account's other machines its whole API — files, git, terminal included — the
 * way it serves its own window.
 */
export function nodeDelegationRoute(method: string, path: string): boolean {
  if (!NODE_METHODS.has(method) || !path.startsWith('/api/')) return false
  const lower = path.toLowerCase()
  if (lower.includes('/../') || lower.endsWith('/..') || lower.includes('/./') || lower.includes('//') || lower.includes('\\')) return false
  return !NODE_DENIED.test(lower)
}

/**
 * JSON that keeps what runtime parts and model input carry besides plain data:
 * binary file content and errors.
 */
export function encodeWire(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item instanceof Uint8Array) return { $bytes: bytesToBase64(item) }
    if (item instanceof Error) return { $error: item.message }
    return item
  })
}

export function decodeWire<T = unknown>(text: string): T {
  return JSON.parse(text, (_key, item: unknown) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const record = item as Record<string, unknown>
      const keys = Object.keys(record)
      if (keys.length === 1 && typeof record.$bytes === 'string') return base64ToBytes(record.$bytes)
      if (keys.length === 1 && typeof record.$error === 'string') return new Error(record.$error)
    }
    return item
  }) as T
}
