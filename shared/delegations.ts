/**
 * Machines of one account using each other: one machine's UI opens another's
 * workspaces (`/api/remote/:nodeId/*`, end to end encrypted through Broker), and
 * a conversation on one machine can start an external agent on another.
 */

export const DELEGATION_NODE_ID = /^[0-9a-f]{32}$/
export const DELEGATION_PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

export interface DelegationMachine {
  nodeId: string
  label: string
  online: boolean
  current: boolean
  /** Paired with this machine (see `MachinePeer`): only then can the two reach each other. */
  paired?: boolean
}

// ── Pairing between machines ────────────────────────────────────────────────
//
// Two machines trust each other only after pairing: one shows a code, the other
// enters it. The code never passes through Broker, and what the two exchange
// under it are their delegation public keys, which each then pins. From then on
// a request between them is sealed with keys derived from the pinned keys, so
// Broker relays it but cannot read or forge it. A machine that joins one member
// of the group is introduced to the rest by that member (`MachinePeerSync`).

/** Another machine this one trusts, or stopped trusting, as Remote settings shows it. */
export interface MachinePeer {
  nodeId: string
  label?: string
  /** Of its delegation public key: what the two machines show to compare, if ever in doubt. */
  fingerprint: string
  status: 'trusted' | 'revoked'
  /** Paired with a code on this machine, or vouched for by `introducedBy`. */
  source: 'paired' | 'introduced'
  introducedBy?: string
  changedAt: number
  lastSeenAt?: number
}

/** One machine's record of another in `MachinePeerSync`. */
export interface MachinePeerRecord {
  nodeId: string
  /** Base64 X25519 public key. */
  publicKey: string
  label?: string
  status: 'trusted' | 'revoked'
  /** When the record last changed; the later record of a machine wins. */
  changedAt: number
}

/**
 * POST /api/delegations/peers/sync (machine → machine): every machine the sender
 * trusts or revoked, so the receiver learns of machines that joined or left
 * through the sender. Accepted only from a paired machine, whatever the receive
 * switch says.
 */
export interface MachinePeerSync {
  peers: MachinePeerRecord[]
}
export const MACHINE_PEER_SYNC_PATH = '/api/delegations/peers/sync'

/**
 * POST /api/delegations/pair/claim (machine entering the code → machine showing
 * it). Not sealed by the transport (the two share no key yet) but under the
 * code: `envelope` opens with the key derived from it.
 */
export const MACHINE_PAIR_CLAIM_PATH = '/api/delegations/pair/claim'

/** What each side of a pairing tells the other, sealed under the code's key. */
export interface MachinePairHello {
  nodeId: string
  /** Base64 X25519 delegation public key. */
  publicKey: string
  label: string
  /** The claimer's random challenge; the answer echoes it back. */
  challenge: string
}

/** A pairing code this machine shows (Remote settings). */
export interface MachinePairingCode {
  code: string
  expiresAt: number
}

/** What became of the code this machine shows. */
export interface MachinePairingCodeStatus {
  status: 'waiting' | 'paired' | 'expired'
  peer?: MachinePeer
}

export interface DelegationWorkspace {
  id: number
  name: string
  project: string
}

/** Where an agent another machine started lives, as its origin shows it. */
export interface RemoteAgentLocation {
  /** The target machine's Broker node id. */
  nodeId: string
  /** Its label when the agent was created. */
  machine: string
  /** "project / workspace" on the target. */
  workspace: string
}

/** For Remote settings: an external agent of this machine that another machine started. */
export interface IncomingDelegation {
  childChatId: number
  sourceNodeId: string
  sourceLabel?: string
  providerId: string
  description: string
  workspace?: string
  status: 'queued' | 'running' | 'completed' | 'cancelled' | 'failed' | 'interrupted' | 'idle'
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
