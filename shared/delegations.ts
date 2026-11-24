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

/** Every path one machine may call on another (checked by the target and by Broker). */
export function nodeDelegationRoute(method: string, path: string): boolean {
  if (method === 'GET' && path === '/api/delegations/catalog') return true
  const models = /^\/api\/delegations\/providers\/([^/]+)\/models$/.exec(path)
  if (models) return method === 'GET' && DELEGATION_PROVIDER_ID.test(models[1])
  const session = /^\/api\/delegations\/sessions\/([^/]+)\/(turn|control)$/.exec(path)
  return !!session && method === 'POST' && DELEGATION_ID.test(session[1])
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
